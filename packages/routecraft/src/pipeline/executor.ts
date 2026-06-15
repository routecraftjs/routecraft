import type { CraftContext } from "../context.ts";
import {
  type Exchange,
  HeadersKeys,
  DefaultExchange,
  EXCHANGE_INTERNALS,
  isDropped,
  OperationType,
  setStartedAt,
} from "../exchange.ts";
import { isRecovery, applyDropDirective } from "../recovery.ts";
import { SPLIT_PARENT_STORE } from "../operations/split.ts";
import { rcError, RoutecraftError } from "../error.ts";
import { isRoutecraftError } from "../brand.ts";
import {
  type Adapter,
  type Step,
  type StepContext,
  type StepOutcome,
  getAdapterLabel,
} from "../types.ts";
import { buildParseStep } from "./synthetic-steps.ts";
import {
  DeadlineExceededError,
  raceWithDeadline,
} from "../operations/timeout-wrapper.ts";
import {
  executeWithRetry,
  type ResolvedRetryOptions,
} from "../operations/retry-wrapper.ts";
import {
  type CircuitBreakerController,
  type CircuitBreakerEventScope,
  circuitBreakerEmitHooks,
  circuitOpenOutcome,
  executeWithCircuitBreaker,
} from "../operations/circuit-breaker-wrapper.ts";
import type { ForwardFn, Route, RouteDefinition } from "../route.ts";

/**
 * Dependencies the pipeline executor needs from the owning route. Passed
 * explicitly so the step loop is a free function (moved verbatim from
 * DefaultRoute.runSteps; only `this.*` references became `deps.*`).
 */
export interface ExecutorDeps {
  routeId: string;
  context: CraftContext;
  /** The owning route, surfaced on error event payloads. */
  route: Route;
  /** Step arrays and the optional route-scope error handler. */
  definition: Pick<
    RouteDefinition,
    | "preParseFilters"
    | "postParseFilters"
    | "steps"
    | "postFromFilters"
    | "errorHandler"
    | "retry"
    | "timeout"
    | "throttle"
    | "circuitBreaker"
  >;
  buildForward(): ForwardFn;
  /**
   * When set and no `errorHandler` is defined, an unhandled failure of
   * the parent exchange THROWS out of `runPipeline` instead of firing
   * the default error path (`route:error` + `context:error` +
   * `route:exchange:failed`). Used by the route-scope resilience
   * segment steps, whose nested executor invocations must surface a
   * failed attempt to the wrapping retry / timeout logic rather than
   * emitting terminal failure events per attempt. Failed split
   * children keep the default per-child accounting.
   *
   * @internal
   */
  rethrowUnhandled?: boolean;
  /**
   * When set, the step loop stops scheduling further steps once the
   * signal aborts: the in-flight step settles, its outcome is
   * discarded, and the queue drains without running the remaining
   * steps. Used by the route-scope timeout segment so an expired
   * attempt cannot keep producing downstream side effects (e.g. a
   * `.to()` firing after the caller already received RC5011).
   *
   * @internal
   */
  abortSignal?: AbortSignal;
}

/**
 * Run the step loop for an exchange.
 *
 * @param exchange The initial exchange to process
 * @param startTime The timestamp when exchange processing started (for duration calculation)
 * @returns The last processed exchange
 * @private
 */
export async function runPipeline(
  deps: ExecutorDeps,
  exchange: Exchange,
  startTime: number,
): Promise<{
  exchange: Exchange;
  failed: boolean;
  dropped: boolean;
  error?: unknown;
}> {
  // If the source adapter attached a `parse` function (see #187), prepend
  // a synthetic step that runs it before any user-defined steps. The step
  // throws an `RC5016` error on parse failure, which then flows through
  // the same error-handler path as any other step error: the route's
  // `.error()` handler is invoked, or `exchange:failed` fires.
  const internals = EXCHANGE_INTERNALS.get(exchange);
  const sourceParse = internals?.parse;
  const sourceValidate = internals?.applyValidation;
  const sourceFailureMode = internals?.parseFailureMode ?? "fail";
  if (internals && sourceParse) {
    // Clear so parse never runs twice on the same exchange (e.g. if the
    // exchange is forwarded back through the queue).
    delete internals.parse;
    delete internals.parseFailureMode;
    delete internals.applyValidation;
  }

  // The route's pre-from filter chain (assembled at builder time in
  // the framework-fixed order documented at
  // `.standards/pre-from-filter-chain.md`). Parse is dynamic per
  // exchange (source-attached) and is interleaved between the two
  // pre-from arrays:
  //
  //   preParseFilters    -> .authorize()
  //   (parse if present) -> source-attached
  //   retry segment      -> route-scope .retry() (#7, wraps the tail)
  //   timeout segment    -> route-scope .timeout() (#8, wraps the tail)
  //   throttle gate      -> route-scope .throttle() (#5, admits once,
  //                         OUTSIDE the retry / timeout segments)
  //   postParseFilters   -> .cache() check (#9), future .circuitBreaker() (#6)
  //   userSteps          -> declaration order, unchanged
  //   postFromFilters    -> .cache() store
  //
  // The route's `.error()` handler wraps the queue loop (filter
  // position #1 in the chain doc); it is implemented as a try/catch
  // around the user pipeline, not a step that calls `next()`.
  //
  // The cache key flows from cache-check to cache-store via
  // `internals.cacheKey` on the exchange -- per-invocation, no
  // shared closure -- so the filter steps can be constructed once
  // at builder time.
  // Chain tail below the route-scope resilience wrappers: cacheCheck
  // (#9), the user pipeline, and cacheStore (#10). Route-scope retry
  // (#7) and timeout (#8) scope OVER this whole segment (retry re-runs
  // it; timeout bounds each run), so they cannot be flat entries in
  // the step array: each becomes a synthetic segment step that runs
  // the tail via a nested executor invocation. Timeout wraps first so
  // retry is outermost: every attempt gets its own deadline
  // (Resilience4J convention, see `.standards/pre-from-filter-chain.md`).
  let tail: Step<Adapter>[] = [
    ...deps.definition.postParseFilters,
    ...deps.definition.steps,
    ...deps.definition.postFromFilters,
  ];
  if (deps.definition.timeout) {
    tail = [
      buildTimeoutSegmentStep(deps, tail, deps.definition.timeout.timeoutMs),
    ];
  }
  if (deps.definition.retry) {
    tail = [buildRetrySegmentStep(deps, tail, deps.definition.retry)];
  }
  // Route-scope circuit breaker (#6) sits OUTSIDE retry / timeout: when
  // open it fast-fails before they run, so the breaker records ONE failure
  // per fully exhausted attempt rather than one per retry. Wrapping it
  // after the retry segment makes it the outer of the two.
  if (deps.definition.circuitBreaker) {
    tail = [
      buildCircuitBreakerSegmentStep(
        deps,
        tail,
        deps.definition.circuitBreaker,
      ),
    ];
  }
  // Route-scope throttle (#5) is the outermost resilience filter: it
  // admits an exchange ONCE, then the retry / timeout segments (and the
  // cache-check + user pipeline below them) run. A retried attempt
  // re-runs only the wrapped tail, so it never re-acquires a token.
  // Unlike retry / timeout it does not scope over the tail, so each gate
  // is a flat sibling step prepended here rather than a wrapping segment;
  // multiple gates (stacked `.throttle()` calls) all run before the tail.
  if (deps.definition.throttle) {
    tail = [...deps.definition.throttle, ...tail];
  }

  const initialSteps: Step<Adapter>[] = [
    ...deps.definition.preParseFilters,
    ...(sourceParse
      ? [buildParseStep(sourceParse, sourceFailureMode, sourceValidate)]
      : []),
    ...tail,
  ];

  const queue: { exchange: Exchange; steps: Step<Adapter>[] }[] = [
    { exchange: exchange, steps: initialSteps },
  ];

  let lastProcessedExchange: Exchange = exchange;
  let failed = false;
  let dropped = false;
  let stepError: unknown;
  // Track child exchanges so we can emit exchange:started/completed for them.
  // The parent exchange (first one) is handled by handler().
  const parentExchangeId = exchange.id;
  const seenChildExchanges = new Set<string>();
  const childStartTimes = new Map<string, number>();
  const failedChildExchanges = new Set<string>();

  // Snapshot existing split parent keys so cleanup only touches groups
  // created during THIS invocation, not groups from concurrent handlers.
  const parentMap = deps.context.getStore(SPLIT_PARENT_STORE) as
    | Map<string, Exchange>
    | undefined;
  const preExistingGroups = parentMap
    ? new Set(parentMap.keys())
    : new Set<string>();

  // Narrow capability handed to steps. takePending implements the same
  // splice scan aggregate used to run against the raw queue, so join
  // semantics (including filter-dropped children: only survivors are
  // collected, nothing waits) are byte-identical to the pre-outcome engine.
  const stepContext: StepContext = {
    takePending(predicate: (candidate: Exchange) => boolean): Exchange[] {
      const taken: Exchange[] = [];
      for (let i = 0; i < queue.length; ) {
        if (predicate(queue[i].exchange)) {
          taken.push(queue[i].exchange);
          queue.splice(i, 1);
        } else {
          i++;
        }
      }
      return taken;
    },
  };

  while (queue.length > 0) {
    // Abandoned segment run (route-scope timeout expired): stop
    // scheduling. The result of this invocation is already discarded
    // by the segment step, so running further steps would only produce
    // side effects after the exchange has failed.
    if (deps.abortSignal?.aborted) break;

    const popped = queue.shift()!;
    const { steps } = popped;
    // `let` because the engine may rewrap the exchange below to update
    // bookkeeping headers (operation label) without mutating the frozen
    // wrapper. Subsequent reads in this iteration use the rewrapped value.
    let exchange = popped.exchange;
    if (steps.length === 0) {
      // Emit exchange:completed for child exchanges when their steps are done
      if (
        exchange.id !== parentExchangeId &&
        seenChildExchanges.has(exchange.id) &&
        !failedChildExchanges.has(exchange.id)
      ) {
        const childStart = childStartTimes.get(exchange.id) ?? startTime;
        const correlationId = exchange.headers[
          HeadersKeys.CORRELATION_ID
        ] as string;
        deps.context.emit("route:exchange:completed", {
          routeId: deps.routeId,
          exchangeId: exchange.id,
          correlationId,
          duration: Date.now() - childStart,
          exchange,
        });
      }
      lastProcessedExchange = exchange;
      continue;
    }

    // Emit exchange:started for child exchanges on first encounter
    if (
      exchange.id !== parentExchangeId &&
      !seenChildExchanges.has(exchange.id)
    ) {
      seenChildExchanges.add(exchange.id);
      const childNow = Date.now();
      childStartTimes.set(exchange.id, childNow);
      // Stash the start timestamp on the exchange's internals so
      // aggregate (and other observers) can read child duration without
      // a side-Map handed across module boundaries. Internals survive
      // `rewrap` because rewrap shares them between prev and next.
      setStartedAt(exchange, childNow);
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      deps.context.emit("route:exchange:started", {
        routeId: deps.routeId,
        exchangeId: exchange.id,
        correlationId,
      });
    }

    const [step, ...remainingSteps] = steps;

    // Prefer the DSL label (e.g., "log") over the raw OperationType (e.g., "tap")
    const stepLabel = step.label ?? step.operation;

    // Update the operation header for this step. Headers are frozen, so
    // we rewrap onto a derived exchange (preserves id and internals).
    // The cost is one allocation per step on top of whatever the step
    // itself produces; in practice the dominant cost is still I/O.
    exchange = DefaultExchange.rewrap(exchange, {
      headers: { ...exchange.headers, [HeadersKeys.OPERATION]: stepLabel },
    });

    const adapterLabel = getAdapterLabel(step.adapter);
    exchange.logger.debug(
      {
        operation: stepLabel,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
      },
      "Processing step",
    );

    const stepStartTime = Date.now();
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;

    // Emit step:started event unless the step manages its own events
    if (!step.skipStepEvents) {
      deps.context.emit("route:step:started", {
        routeId: deps.routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
      });
    }

    try {
      const outcome = await step.execute(exchange, stepContext);

      // The executor owns scheduling: translate the outcome into queue
      // entries. Pushes carry no events, so push-vs-emit ordering below
      // is observationally identical to the old in-step pushes.
      switch (outcome.kind) {
        case "continue":
          queue.push({ exchange: outcome.exchange, steps: remainingSteps });
          break;
        case "complete":
          queue.push({ exchange: outcome.exchange, steps: [] });
          break;
        case "branch":
          queue.push({
            exchange: outcome.exchange,
            steps: [...outcome.steps, ...remainingSteps],
          });
          break;
        case "fanOut":
          for (const child of outcome.exchanges) {
            queue.push({ exchange: child, steps: remainingSteps });
          }
          break;
        case "drop":
          // The step marked the exchange dropped and emitted its drop
          // events; schedule nothing.
          break;
        case "suspend":
          // Reserved StepOutcome kind: declared for the route-level
          // suspend/resume feature but not yet producible. No step returns
          // it today, so reaching here means a custom step emitted a kind the
          // engine cannot yet schedule. Fail loud rather than silently drop
          // the exchange.
          throw rcError("RC5032", undefined, {
            message: `Step "${stepLabel}" returned a "suspend" outcome, but suspend/resume is not implemented yet.`,
          });
      }

      // Emit step:completed event unless the step manages its own events
      if (!step.skipStepEvents) {
        const stepDuration = Date.now() - stepStartTime;
        const correlationId = exchange.headers[
          HeadersKeys.CORRELATION_ID
        ] as string;
        deps.context.emit("route:step:completed", {
          routeId: deps.routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: stepLabel,
          ...(adapterLabel ? { adapter: adapterLabel } : {}),
          duration: stepDuration,
          // Adapter-populated observability metadata (e.g. LLM token
          // usage from to/enrich getMetadata), carried on the outcome.
          ...("metadata" in outcome && outcome.metadata
            ? { metadata: outcome.metadata }
            : {}),
        });
      }
    } catch (error) {
      const err = processError(error);
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      const duration = Date.now() - startTime;

      // Emit step-level error
      deps.context.emit("route:step:error", {
        routeId: deps.routeId,
        error: err,
        route: deps.route,
        exchange,
        operation: stepLabel,
      });

      if (deps.definition.errorHandler) {
        // Route-scope error-handler events. Step-scope wrappers
        // emit the same set with `scope: "step"` and `stepLabel`.
        deps.context.emit("route:error-handler:invoked", {
          routeId: deps.routeId,
          exchangeId: exchange.id,
          correlationId,
          originalError: err,
          failedOperation: stepLabel,
          scope: "route",
        });

        try {
          const forward = deps.buildForward();
          const result = await deps.definition.errorHandler(
            err,
            exchange,
            forward,
          );
          if (isRecovery(result)) {
            if (result.kind === "rethrow") {
              // Declarative equivalent of `throw error` inside the
              // handler: fall through to the handler-threw path below
              // with the original error.
              throw err;
            }
            // `recovery.drop()`: resolve the error by discarding the
            // exchange (shared semantics in applyDropDirective).
            applyDropDirective({
              context: deps.context,
              routeId: deps.routeId,
              exchange,
              originalError: err,
              failedOperation: stepLabel,
              correlationId,
              reason: result.reason,
              scope: "route",
              route: deps.route,
            });
            // Only a drop of the PARENT exchange marks the run dropped
            // (suppressing the parent's exchange:completed). A dropped
            // split CHILD resolves that child alone, mirroring the
            // handler-threw path's failedChildExchanges accounting.
            if (exchange.id === parentExchangeId) {
              dropped = true;
            }
          } else {
            // Replace body via rewrap (frozen exchange); keep id and
            // internals so telemetry continues to reference the same
            // logical exchange.
            const recovered = DefaultExchange.rewrap(exchange, {
              body: result,
            });
            lastProcessedExchange = recovered;

            // Error handler recovered
            deps.context.emit("route:error:caught", {
              routeId: deps.routeId,
              error: err,
              route: deps.route,
              exchange: recovered,
            });
            deps.context.emit("route:error-handler:recovered", {
              routeId: deps.routeId,
              exchangeId: recovered.id,
              correlationId,
              originalError: err,
              failedOperation: stepLabel,
              recoveryStrategy: "route-error-handler",
              scope: "route",
            });
          }
        } catch (handlerError) {
          const handlerErr = processError(handlerError);
          exchange.logger.error(
            {
              operation: stepLabel,
              err: handlerErr,
              context: "error handler",
            },
            handlerErr.meta.message,
          );
          deps.context.emit("route:error-handler:failed", {
            routeId: deps.routeId,
            exchangeId: exchange.id,
            correlationId,
            originalError: err,
            failedOperation: stepLabel,
            recoveryStrategy: "route-error-handler",
            scope: "route",
          });
          // Error handler rethrew -- route-level + context-level error
          deps.context.emit("route:error", {
            routeId: deps.routeId,
            error: handlerErr,
            route: deps.route,
            exchange,
          });
          deps.context.emit("context:error", {
            error: handlerErr,
            route: deps.route,
            exchange,
          });
          deps.context.emit("route:exchange:failed", {
            routeId: deps.routeId,
            exchangeId: exchange.id,
            correlationId,
            duration,
            error: handlerErr,
            exchange,
          });
          if (exchange.id !== parentExchangeId) {
            failedChildExchanges.add(exchange.id);
          } else {
            failed = true;
            stepError = handlerErr;
          }
        }

        // Pipeline does not resume after error handler (success or failure)
        return {
          exchange: lastProcessedExchange,
          failed,
          dropped,
          error: stepError,
        };
      }

      // No error handler -- inside a nested resilience segment the
      // parent's failure must surface to the wrapping segment step
      // (retry decides whether to re-attempt; timeout maps its own
      // expiry) instead of firing the default error path per attempt.
      // Failed split children keep the default per-child accounting
      // below.
      if (deps.rethrowUnhandled && exchange.id === parentExchangeId) {
        throw err;
      }

      // No error handler -- route-level error
      exchange.logger.error(
        {
          operation: stepLabel,
          ...(adapterLabel ? { adapter: adapterLabel } : {}),
          err,
        },
        err.meta.message,
      );
      // No error handler -- route-level + context-level error
      deps.context.emit("route:error", {
        routeId: deps.routeId,
        error: err,
        route: deps.route,
        exchange,
      });
      deps.context.emit("context:error", {
        error: err,
        route: deps.route,
        exchange,
      });
      deps.context.emit("route:exchange:failed", {
        routeId: deps.routeId,
        exchangeId: exchange.id,
        correlationId,
        duration,
        error: err,
        exchange,
      });
      if (exchange.id !== parentExchangeId) {
        failedChildExchanges.add(exchange.id);
      } else {
        failed = true;
        stepError = err;
      }

      // Don't re-throw - error is logged and emitted via events.
      // The error is returned in the result so callers (e.g. CraftClient)
      // can handle it. Source adapters catch and continue.
      // Do NOT return here: the while loop continues so other queue items (e.g. split children) are processed
    }
  }

  // Clean up orphaned split parent map entries added during THIS invocation.
  // Only touch groups that did not exist before runSteps started, to avoid
  // deleting entries owned by concurrent handlers on the same context.
  if (parentMap && parentMap.size > 0) {
    for (const groupId of Array.from(parentMap.keys())) {
      if (preExistingGroups.has(groupId)) continue;
      const parentEx = parentMap.get(groupId);
      if (parentEx) {
        const hierarchy = parentEx.headers[HeadersKeys.SPLIT_HIERARCHY] as
          | string[]
          | undefined;
        // Only clean up groups that are NOT part of a nested hierarchy
        if (!hierarchy || !hierarchy.includes(groupId)) {
          parentMap.delete(groupId);
        }
      }
    }
  }

  // Check if the root exchange was dropped (e.g. by a filter). The drop
  // flag lives on the exchange's shared internals object (see
  // `markDropped` / `isDropped` in `exchange.ts`), so it survives the
  // engine's per-step `rewrap`: an operation that marks the rewrapped
  // exchange handed to it remains visible from the outer parameter
  // because both reference the same internals.
  if (isDropped(exchange)) {
    dropped = true;
  }

  // Route-scope cache writes (`cacheConfig`) are handled inline by
  // the `cache-store` synthetic step appended to `initialSteps` at
  // the top of this function. Nothing to do here.

  return {
    exchange: lastProcessedExchange,
    failed,
    dropped,
    error: stepError,
  };
}

/**
 * Synthetic adapter carriers for the route-scope resilience segment
 * steps. Distinct adapter ids so telemetry correlating by `adapter`
 * can tell retry re-runs (`routecraft.retry`) from deadline guards
 * (`routecraft.timeout`) without parsing the step label. Neither
 * carrier has behaviour; the steps' `execute` does the work.
 */
const RETRY_SEGMENT_ADAPTER: Adapter = { adapterId: "routecraft.retry" };
const TIMEOUT_SEGMENT_ADAPTER: Adapter = { adapterId: "routecraft.timeout" };
const CIRCUIT_BREAKER_SEGMENT_ADAPTER: Adapter = {
  adapterId: "routecraft.circuitBreaker",
};

/**
 * Convert a nested segment run's result into the {@link StepOutcome} the
 * outer pipeline schedules: a deliberately dropped run resolves as a
 * drop, every other run continues with the produced exchange. Shared by
 * the timeout / retry / circuit-breaker segment builders so the mapping
 * lives in one place.
 */
function segmentResultToOutcome(result: {
  exchange: Exchange;
  dropped: boolean;
}): StepOutcome {
  return result.dropped
    ? ({ kind: "drop" } as const)
    : ({ kind: "continue", exchange: result.exchange } as const);
}

/**
 * Executor deps for a nested segment run: same route identity and
 * capabilities, but the step arrays carry only the wrapped segment and
 * no `errorHandler` / `retry` / `timeout` (the outer invocation owns
 * filter #1 and the segment wrappers themselves; omitting them here is
 * also what stops the nested run from re-wrapping recursively).
 * `rethrowUnhandled` makes a failed attempt throw out of the nested
 * `runPipeline` so the segment step can react.
 */
function nestedSegmentDeps(
  deps: ExecutorDeps,
  segment: Step<Adapter>[],
  abortSignal?: AbortSignal,
): ExecutorDeps {
  return {
    routeId: deps.routeId,
    context: deps.context,
    route: deps.route,
    buildForward: () => deps.buildForward(),
    rethrowUnhandled: true,
    ...(abortSignal ? { abortSignal } : {}),
    definition: {
      preParseFilters: [],
      postParseFilters: [],
      steps: segment,
      postFromFilters: [],
    },
  };
}

/**
 * Build the route-scope `.timeout()` segment step (pre-from chain
 * position #8). Runs the chain tail via a nested executor invocation
 * raced against the deadline. On expiry, emits `route:timeout:expired`,
 * throws `RC5011`, and aborts the nested run: the in-flight step
 * settles (promises cannot be cancelled) with its outcome discarded,
 * and no further steps are scheduled, so an expired attempt cannot
 * keep producing downstream side effects.
 *
 * `skipStepEvents: true` keeps `runPipeline` from emitting generic
 * lifecycle events for this internal step; the segment emits its own
 * `route:timeout:*` family with `scope: "route"`.
 */
function buildTimeoutSegmentStep(
  deps: ExecutorDeps,
  segment: Step<Adapter>[],
  timeoutMs: number,
): Step<Adapter> {
  return {
    operation: OperationType.PROCESS,
    label: "timeout",
    adapter: TIMEOUT_SEGMENT_ADAPTER,
    skipStepEvents: true,
    async execute(exchange) {
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      const scoped = {
        routeId: deps.routeId,
        exchangeId: exchange.id,
        correlationId,
        stepLabel: "route",
        scope: "route" as const,
        timeoutMs,
      };
      deps.context.emit("route:timeout:started", scoped);
      const start = Date.now();
      const abandon = new AbortController();
      try {
        const result = await raceWithDeadline(
          runPipeline(
            nestedSegmentDeps(deps, segment, abandon.signal),
            exchange,
            Date.now(),
          ),
          timeoutMs,
        );
        deps.context.emit("route:timeout:stopped", {
          ...scoped,
          elapsed: Date.now() - start,
        });
        return segmentResultToOutcome(result);
      } catch (err) {
        if (!(err instanceof DeadlineExceededError)) throw err;
        // Stop the abandoned run from scheduling further steps: its
        // result is discarded, so any remaining steps would only run
        // side effects after the exchange has already failed.
        abandon.abort();
        deps.context.emit("route:timeout:expired", {
          ...scoped,
          elapsed: Date.now() - start,
        });
        throw rcError("RC5011", undefined, {
          message: `Route "${deps.routeId}" pipeline exceeded its ${timeoutMs}ms timeout`,
        });
      }
    },
  };
}

/**
 * Build the route-scope `.retry()` segment step (pre-from chain
 * position #7). Re-runs the chain tail (including a nested timeout
 * segment, the cache check, the user pipeline, and the cache store)
 * via nested executor invocations until an attempt succeeds, the error
 * is non-retryable, or attempts are exhausted; then the final error
 * propagates unchanged to the route-scope `.error()` handler or the
 * default error path.
 *
 * A dropped attempt (filter rejection, parse-drop) is a deliberate
 * resolution, not a failure: it is never re-attempted.
 */
function buildRetrySegmentStep(
  deps: ExecutorDeps,
  segment: Step<Adapter>[],
  options: ResolvedRetryOptions,
): Step<Adapter> {
  return {
    operation: OperationType.PROCESS,
    label: "retry",
    adapter: RETRY_SEGMENT_ADAPTER,
    skipStepEvents: true,
    async execute(exchange) {
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      const scoped = {
        routeId: deps.routeId,
        exchangeId: exchange.id,
        correlationId,
        stepLabel: "route",
        scope: "route" as const,
      };
      const result = await executeWithRetry(
        () =>
          runPipeline(nestedSegmentDeps(deps, segment), exchange, Date.now()),
        options,
        {
          signal: deps.route.signal,
          onStarted: () => {
            deps.context.emit("route:retry:started", {
              ...scoped,
              maxAttempts: options.maxAttempts,
            });
          },
          onAttempt: (attemptNumber, waitMs, lastError) => {
            deps.context.emit("route:retry:attempt", {
              ...scoped,
              attemptNumber,
              maxAttempts: options.maxAttempts,
              backoffMs: waitMs,
              lastError,
            });
          },
          onStopped: (attemptNumber, success, error) => {
            deps.context.emit("route:retry:stopped", {
              ...scoped,
              attemptNumber,
              success,
              ...(error !== undefined ? { error } : {}),
            });
          },
        },
      );
      return segmentResultToOutcome(result);
    },
  };
}

/**
 * Build the route-scope `.circuitBreaker()` segment step (pre-from chain
 * position #6). Wraps the chain tail (the retry / timeout segments, the
 * cache check, the user pipeline, and the cache store). On each exchange
 * the breaker decides whether to admit the call:
 *
 * - OPEN (cooldown not elapsed) or HALF-OPEN at capacity: fast-fail
 *   WITHOUT running the tail. With a `fallback` the configured value
 *   becomes the body and the pipeline completes; without one it throws
 *   `RC5025` to the route-scope `.error()` handler (or the default error
 *   path).
 * - CLOSED, or HALF-OPEN with a free probe slot: run the tail via a
 *   nested executor invocation (`rethrowUnhandled`, so a failed attempt
 *   surfaces here). A success closes a half-open breaker; a counted
 *   failure trips a closed breaker or re-opens a half-open one.
 *
 * Because it sits OUTSIDE retry, one fully exhausted attempt (after retry
 * gives up) is recorded as a single breaker failure, not one per retry.
 *
 * The breaker `controller` is built once per route definition (in
 * `RouteBuilder.from`) and holds the persistent per-Route state, so it is
 * passed in rather than constructed here. `skipStepEvents: true` keeps
 * `runPipeline` from emitting generic lifecycle events for this internal
 * step; the segment emits its own `route:circuitBreaker:*` family with
 * `scope: "route"`.
 */
function buildCircuitBreakerSegmentStep(
  deps: ExecutorDeps,
  segment: Step<Adapter>[],
  controller: CircuitBreakerController,
): Step<Adapter> {
  return {
    operation: OperationType.CIRCUIT_BREAKER,
    label: "circuitBreaker",
    adapter: CIRCUIT_BREAKER_SEGMENT_ADAPTER,
    skipStepEvents: true,
    async execute(exchange) {
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      const scoped: CircuitBreakerEventScope = {
        routeId: deps.routeId,
        exchangeId: exchange.id,
        correlationId,
        stepLabel: "route",
        scope: "route",
        ...(controller.label !== undefined ? { label: controller.label } : {}),
      };
      const hooks = circuitBreakerEmitHooks(
        deps.context,
        scoped,
        true,
        controller.options,
      );

      const forward = deps.buildForward();

      return executeWithCircuitBreaker(
        controller,
        deps.route,
        hooks,
        () =>
          circuitOpenOutcome(
            exchange,
            controller.options,
            forward,
            `for route "${deps.routeId}"`,
          ),
        async () =>
          segmentResultToOutcome(
            await runPipeline(
              nestedSegmentDeps(deps, segment),
              exchange,
              Date.now(),
            ),
          ),
      );
    },
  };
}

/**
 * Normalize an operation error into a RoutecraftError.
 * If the error is already a RoutecraftError, it is returned unchanged.
 *
 * @param error - The thrown value (Error or RoutecraftError)
 * @returns A RoutecraftError (existing or RC5001-wrapped)
 * @private
 */
export function processError(error: unknown): RoutecraftError {
  if (isRoutecraftError(error)) {
    return error as RoutecraftError;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return rcError("RC5001", error, { message: msg });
}
