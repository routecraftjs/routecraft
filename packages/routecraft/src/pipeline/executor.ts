import type { CraftContext } from "../context.ts";
import { anySignal } from "../shared/abort.ts";
import {
  type Exchange,
  HeadersKeys,
  DefaultExchange,
  EXCHANGE_INTERNALS,
  clearResumeStepState,
  isDropped,
  isSuspendedRun,
  OperationType,
  peekResumeStepState,
  setResumeStepState,
  setStartedAt,
} from "../exchange.ts";
import { isRecovery, applyDropDirective } from "../recovery.ts";
import { parkExchange } from "../suspension/park.ts";
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
import { buildInputValidationStep, buildParseStep } from "./synthetic-steps.ts";
import { applyOutputStage } from "./validation.ts";
import {
  CHAIN_SURVIVAL,
  type ExecutedDefinition,
  type DetachedKind,
  detachedDefinition,
} from "./chain-policy.ts";
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
import {
  type ConcurrencyController,
  type ConcurrencyEventScope,
  concurrencyEmitHooks,
  executeWithConcurrency,
} from "../operations/concurrency-wrapper.ts";
import type { ForwardFn, Route } from "../route.ts";

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
  /**
   * The chain positions this run executes under, plus its steps.
   *
   * Deliberately the same type the detached policy produces. Listing the
   * fields again here would be a second place to forget one, and the whole
   * point of deriving the policy from `RouteDefinition` is that there is
   * only one.
   */
  definition: ExecutedDefinition;
  /** Build a forward callable whose target inherits `caller`'s headers. */
  buildForward: (caller: Exchange) => ForwardFn;
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
  /**
   * When set, route-scope `.concurrency()` queues this run for a slot
   * rather than refusing it. Resolved from `CHAIN_SURVIVAL.concurrency`,
   * which is where a kind declares whether it can absorb a refusal.
   *
   * The bound still holds: the semaphore is the route's own, shared with
   * the ingress leg, so this waits for the same slot rather than escaping
   * the limit.
   *
   * @internal
   */
  admissionMustWait?: boolean;
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
  /** The exchange parked at a `.suspend()`; execution one ends here. */
  suspended: boolean;
  error?: unknown;
}> {
  // If the source adapter attached a `parse` function (see #187), prepend
  // a synthetic step that runs it before any user-defined steps. The step
  // throws an `RC5016` error on parse failure, which then flows through
  // the same error-handler path as any other step error: the route's
  // `.error()` handler is invoked, or `exchange:failed` fires.
  //
  // `.input()` validation (chain position #4) rides the same internals
  // slot: with a parser it runs inside the parse step (input validates
  // the parsed body, so #3 and #4 collapse into one step); without one it
  // becomes a standalone synthetic input step in the same position. Both
  // paths throw `RC5002` into this run's catch boundary, so a validation
  // failure is routable through `.error()` regardless of the source
  // shape (#447).
  const internals = EXCHANGE_INTERNALS.get(exchange);
  const sourceParse = internals?.parse;
  const sourceValidate = internals?.applyValidation;
  const sourceFailureMode = internals?.parseFailureMode ?? "fail";
  if (internals && (sourceParse || sourceValidate)) {
    // Clear so parse / validation never run twice on the same exchange
    // (e.g. if the exchange is forwarded back through the queue).
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
  //   (parse if present) -> source-attached; runs .input() after parse
  //   (input if present) -> .input() as a standalone step when no parser
  //   retry segment      -> route-scope .retry() (#7, wraps the tail)
  //   timeout segment    -> route-scope .timeout() (#8, wraps the tail)
  //   concurrency segment-> route-scope .concurrency() (bulkhead, innermost
  //                         resilience layer: wraps the tail INSIDE retry /
  //                         timeout so a slot is held per attempt only)
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
  // Route-scope concurrency (bulkhead) is the INNERMOST resilience layer:
  // it wraps the chain tail BEFORE timeout / retry / breaker so a slot is
  // acquired per attempt and released between retry backoffs (a scarce slot
  // is never held while a retry sleeps), and an outer retry can re-acquire
  // one after a reject-mode RC5026. Multiple controllers (stacked
  // `.concurrency()` calls) nest; the first declared ends up outermost
  // among them because each successive wrap goes around the previous.
  if (deps.definition.concurrency) {
    for (let i = deps.definition.concurrency.length - 1; i >= 0; i--) {
      tail = [
        buildConcurrencySegmentStep(
          deps,
          tail,
          deps.definition.concurrency[i]!,
        ),
      ];
    }
  }
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
      : sourceValidate
        ? [buildInputValidationStep(sourceValidate)]
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
    Map<string, Exchange> | undefined;
  const preExistingGroups = parentMap
    ? new Set(parentMap.keys())
    : new Set<string>();

  // Tracks the steps that follow the currently-executing step, refreshed each
  // loop iteration. `captureDownstream` snapshots it so a step (debounce) can
  // release a held exchange through its downstream continuation later.
  let currentRemaining: Step<Adapter>[] = [];

  // Narrow capability handed to steps. takePending implements the same
  // splice scan aggregate used to run against the raw queue, so join
  // semantics (including filter-dropped children: only survivors are
  // collected, nothing waits) are byte-identical to the pre-outcome engine.
  const stepContext: StepContext = {
    // Surface the abandon signal (route-scope timeout) to the steps
    // themselves, not just the scheduling loop below: a step doing
    // cancellation-aware IO forwards it into fetch / DB drivers so an
    // expired attempt stops working, instead of merely having its
    // outcome discarded. Step-scope `.timeout()` composes on top by
    // deriving a linked signal per wrapped step.
    ...(deps.abortSignal ? { signal: deps.abortSignal } : {}),
    takePending(predicate: (candidate: Exchange) => boolean): Exchange[] {
      const taken: Exchange[] = [];
      for (let i = 0; i < queue.length;) {
        if (predicate(queue[i].exchange)) {
          taken.push(queue[i].exchange);
          queue.splice(i, 1);
        } else {
          i++;
        }
      }
      return taken;
    },
    async runPaths(runs): Promise<void> {
      // Each path is its own isolated nested pipeline run on a clone. They
      // run concurrently and we wait for all of them to settle: a path
      // failure surfaces as that clone's default error events (the nested
      // deps carry no `rethrowUnhandled`) and never rejects this call, so
      // one bad path cannot take the route down. The original exchange is
      // untouched and continues once every path has settled.
      await Promise.allSettled(
        runs.map((run) =>
          runPipeline(
            // Forward any outer abortSignal (a route-scope timeout) so an
            // expired attempt stops scheduling in-flight paths; omit
            // rethrowUnhandled so a failing path stays isolated.
            nestedDeps(deps, run.steps, { abortSignal: deps.abortSignal }),
            run.exchange,
            Date.now(),
          ),
        ),
      );
    },
    async runPath(run): Promise<{
      failed: boolean;
      dropped: boolean;
      error?: unknown;
      aborted?: boolean;
    }> {
      // Single isolated nested run that reports its outcome back. Same
      // isolation as a runPaths entry (no rethrowUnhandled, so a failure
      // fires the clone's own error events rather than propagating), but the
      // result is returned so a caller can react (dispatch failover advances
      // to the next target on `failed`). The outer abortSignal is forwarded
      // so a route-scope timeout can stop an in-flight target.
      const result = await runPipeline(
        nestedDeps(deps, run.steps, { abortSignal: deps.abortSignal }),
        run.exchange,
        Date.now(),
      );
      return {
        failed: result.failed,
        dropped: result.dropped,
        // The nested run stops scheduling once the outer abortSignal fires;
        // report the truncation so a caller (dispatch failover) does not
        // mistake an abandoned attempt for a handled exchange.
        aborted: deps.abortSignal?.aborted === true,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    },
    captureDownstream(): (
      exchange: Exchange,
    ) => Promise<{ failed: boolean; dropped: boolean }> {
      // Snapshot the downstream steps for the CURRENT step now; the runner
      // itself is built by a module-level factory so it captures only
      // route-stable state. See makeDownstreamRunner for the full contract
      // (no inherited abort signal, route-scope error handler honored,
      // output validation applied).
      return makeDownstreamRunner(deps, currentRemaining);
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
    // Expose the downstream continuation for a step that wants to capture it
    // (debounce releasing a held exchange later); refreshed every iteration.
    currentRemaining = remainingSteps;

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
      // A settled step consumed any resume step state a revival attached:
      // the re-entrant host is by construction the first step of its
      // continuation, so clearing on every committed outcome keeps the
      // once-only contract while a thrown attempt (a retryable provider
      // failure) leaves the state in place for the retry to resume.
      clearResumeStepState(exchange);

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
        case "suspend": {
          // The exchange parks here and this run ends: the executor
          // serializes it, writes the suspension, and answers with the
          // `Suspended` acknowledgment. Nothing is scheduled beyond that
          // (`steps: []`), no worker waits, and the route stays live for
          // every other exchange, because the continuation lives in the
          // store rather than in this process.
          if (!outcome.request) {
            throw rcError("RC5032", undefined, {
              message: `Step "${stepLabel}" returned a "suspend" outcome without a suspend request, so the engine cannot work out what to park or what would resume.`,
            });
          }
          // A cancelled run must not leave a live resume link behind: the
          // caller is being told the run failed (a timeout, a stop), so an
          // approver clicking days later would continue work its caller
          // already saw cancelled. Before the store write, refusing to park
          // is free; an abort that lands during the write is resolved
          // inside `parkExchange` (deny, then RC5054) BEFORE the suspended
          // event, so one exchange never announces two terminals. The
          // caller's RC5054 is the notification; no re-ask is delivered.
          if (deps.abortSignal?.aborted) {
            throw rcError("RC5054", deps.abortSignal.reason, {
              message: `Step "${stepLabel}" raised a suspension after its run was cancelled; nothing was parked.`,
            });
          }
          const parked = await parkExchange(
            deps.context,
            outcome.exchange,
            outcome.request,
            deps.routeId,
            deps.abortSignal,
          );
          queue.push({ exchange: parked, steps: [] });
          break;
        }
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

      // Emit step-level error, unless this run was already abandoned by
      // an outer abort (a route-scope timeout that expired). Since the
      // wrapped step now receives that abort through its StepContext
      // signal, a cancellation-aware step FAILS on expiry rather than
      // running to completion with a discarded outcome. That failure is
      // a consequence of the deadline the segment step has already
      // reported (RC5011), not an independent step error, so surfacing
      // it would add a spurious `route:step:error` per expiry for
      // exactly the steps that cooperate with cancellation. The
      // abandoned run's result is discarded either way.
      if (!deps.abortSignal?.aborted) {
        deps.context.emit("route:step:error", {
          routeId: deps.routeId,
          error: err,
          route: deps.route,
          exchange,
          operation: stepLabel,
        });
      }

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
          const forward = deps.buildForward(exchange);
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
          suspended: isSuspendedRun(exchange),
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
          string[] | undefined;
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
    suspended: isSuspendedRun(exchange),
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
const CONCURRENCY_SEGMENT_ADAPTER: Adapter = {
  adapterId: "routecraft.concurrency",
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
  if (result.dropped) return { kind: "drop" } as const;
  // A run that parked inside the segment has already been answered with its
  // `Suspended` acknowledgment, and the parking is recorded on the
  // exchange's shared internals, so the outer run must schedule nothing
  // further rather than continuing into steps the parked exchange is no
  // longer at. It is `complete`, not a second `suspend`: the exchange is
  // parked once, by the run that reached the step.
  if (isSuspendedRun(result.exchange)) {
    return { kind: "complete", exchange: result.exchange } as const;
  }
  return { kind: "continue", exchange: result.exchange } as const;
}

/**
 * Executor deps for a nested `runPipeline` invocation: same route identity
 * and capabilities, but the step array carries only the wrapped segment and
 * no `errorHandler` / `retry` / `timeout` (the outer invocation owns filter
 * #1 and the segment wrappers themselves; omitting them here is also what
 * stops the nested run from re-wrapping recursively).
 *
 * Two callers, distinguished by `opts`:
 * - Resilience segments (timeout / retry / circuit breaker) pass
 *   `rethrowUnhandled: true` so a failed attempt throws out of the nested
 *   run and the segment step can react, and the timeout segment additionally
 *   passes its `abortSignal` so an expired attempt stops scheduling.
 * - Multicast paths omit `rethrowUnhandled` so a path that throws resolves
 *   through the default error path for its own clone (firing that exchange's
 *   `route:error` / `context:error` / `route:exchange:failed`) rather than
 *   propagating -- one failing path neither rejects `runPaths` nor disturbs
 *   the others -- while still forwarding any outer `abortSignal` so a
 *   route-scope timeout can stop in-flight paths.
 *
 * The empty definition is deliberately outside `CHAIN_SURVIVAL`: a nested
 * segment is not a re-entry, so it has nothing to declare per position. The
 * invocation above it already applied the chain.
 */
function nestedDeps(
  deps: ExecutorDeps,
  segment: Step<Adapter>[],
  opts: {
    rethrowUnhandled?: boolean;
    abortSignal?: AbortSignal | undefined;
  } = {},
): ExecutorDeps {
  return {
    routeId: deps.routeId,
    context: deps.context,
    route: deps.route,
    buildForward: deps.buildForward,
    ...(opts.rethrowUnhandled ? { rethrowUnhandled: true } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    definition: {
      preParseFilters: [],
      postParseFilters: [],
      steps: segment,
      postFromFilters: [],
    },
  };
}

/**
 * Build the detached-release runner handed out by `captureDownstream`.
 *
 * Module-level on purpose, for two verified reasons:
 *
 * - The returned closure must capture ONLY route-stable state (`deps` and
 *   the downstream step array). Building it inside `runPipeline` would chain
 *   it to that invocation's activation context (pinning the capturing
 *   arrival's queue for as long as the runner is retained) and, worse, to
 *   `deps.abortSignal`: when the capturing arrival ran inside a route-scope
 *   timeout / concurrency attempt, that per-attempt signal can abort later
 *   and would permanently poison every future release into scheduling zero
 *   steps. A released exchange is a fresh detached flow, so it inherits NO
 *   abort signal.
 * - For a holding operation (debounce) the released exchange IS the route's
 *   primary flow, not a side effect, so unlike fan-out paths the detached
 *   run honors the route-scope `.error()` handler and enforces the route's
 *   `.output()` schemas before completion. Both are read from
 *   `deps.route.definition` (the full definition) because the capturing
 *   invocation may be a nested segment whose own `deps.definition` has them
 *   stripped.
 *
 * The released exchange gets its own `exchange:started` / `:completed`
 * lifecycle pair, and the run is `trackTask`ed so `drain()` waits for it.
 */
function makeDownstreamRunner(
  deps: ExecutorDeps,
  downstream: Step<Adapter>[],
): (exchange: Exchange) => Promise<{ failed: boolean; dropped: boolean }> {
  return (releaseExchange) => {
    const release = runDetachedPipeline(
      deps,
      downstream,
      releaseExchange,
      "debounce",
    );
    // Track the ENTIRE release flow (pipeline, output validation, and the
    // completion emit), not just the pipeline promise: a caller that does not
    // itself await the runner to completion (debounce's settle latch does,
    // but the contract must not depend on the caller) would otherwise let
    // drain() return between the pipeline settling and the validation /
    // completed emit finishing.
    deps.route.trackTask(release);
    return release;
  };
}

/**
 * Run `steps` against `exchange` as a detached, first-class run of the
 * route: its own `exchange:started` / `:completed` pair, the route-scope
 * `.error()` handler honoured, and the route's `.output()` schemas enforced
 * before completion.
 *
 * Two callers, sharing the run's shape but not its chain. `debounce`
 * releases a held exchange into the steps that follow it, and a resume
 * revives a parked exchange into its continuation. Neither is a side-effect
 * clone: in both cases the exchange IS the route's primary flow, resuming
 * partway down a pipeline whose earlier steps must not re-run.
 *
 * `kind` is what separates them, because the chain above the entry point
 * means different things for each: a released exchange is work the route
 * held back and never admitted, while a resumed one entered the route once
 * and was admitted then. Which positions apply is declared per position in
 * `chain-policy.ts` rather than decided here.
 *
 * The run inherits NO abort signal. A signal from the capturing attempt (a
 * route-scope timeout) can fire long after, and a detached run is a fresh
 * flow rather than a continuation of that attempt.
 *
 * @param kind - Which detached run this is, selecting the chain policy
 *
 * @internal
 */
export function runDetachedPipeline(
  deps: ExecutorDeps,
  downstream: ReadonlyArray<Step<Adapter>>,
  releaseExchange: Exchange,
  kind: DetachedKind,
): Promise<DetachedResult> {
  return (async (): Promise<DetachedResult> => {
    const start = Date.now();
    const correlationId = releaseExchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    deps.context.emit("route:exchange:started", {
      routeId: deps.routeId,
      exchangeId: releaseExchange.id,
      correlationId,
    });
    const routeDefinition = deps.route.definition;
    const nested: ExecutorDeps = {
      routeId: deps.routeId,
      context: deps.context,
      route: deps.route,
      buildForward: deps.buildForward,
      definition: detachedDefinition(routeDefinition, downstream, kind),
      ...(CHAIN_SURVIVAL.concurrency[kind].mustNotRefuse
        ? { admissionMustWait: true }
        : {}),
    };
    let result = await runPipeline(nested, releaseExchange, start);

    // The released exchange carries the route's final output, so the same
    // output stage the source-driven path uses runs here too.
    result = await applyOutputStage(
      {
        routeId: deps.routeId,
        context: deps.context,
        route: deps.route,
        buildForward: deps.buildForward,
        ...(routeDefinition.errorHandler
          ? { errorHandler: routeDefinition.errorHandler }
          : {}),
      },
      routeDefinition.discovery?.output,
      result,
      start,
    );

    // A run that parked at a `.suspend()` ends with the `Suspended`
    // acknowledgment rather than the route's output, and its terminal
    // event was `route:exchange:suspended`. Completing it here would both
    // claim an output it does not carry and give the exchange two
    // terminal events.
    if (!result.failed && !result.dropped && !result.suspended) {
      deps.context.emit("route:exchange:completed", {
        routeId: deps.routeId,
        exchangeId: releaseExchange.id,
        correlationId,
        duration: Date.now() - start,
        exchange: result.exchange,
      });
    }
    return {
      failed: result.failed,
      dropped: result.dropped,
      suspended: result.suspended,
      exchange: result.exchange,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  })();
}

/**
 * What a detached run reports back. `error` is present exactly when
 * `failed` is true and the failure reached the run's boundary, which is
 * what a resume needs to cache as the suspension's terminal outcome.
 *
 * @internal
 */
export interface DetachedResult {
  failed: boolean;
  dropped: boolean;
  /**
   * The run parked at a `.suspend()`. Distinct from every other outcome:
   * the exchange is neither finished nor failed, and its terminal body is
   * the `Suspended` acknowledgment rather than the route's output. A caller
   * that treats it as a completion publishes both a false receipt and the
   * next suspension's resume token.
   */
  suspended: boolean;
  exchange: Exchange;
  error?: unknown;
}

/**
 * Build the route-scope `.timeout()` segment step (pre-from chain
 * position #8). Runs the chain tail via a nested executor invocation
 * raced against the deadline. On expiry, emits `route:timeout:expired`,
 * throws `RC5011`, and aborts the nested run: no further steps are
 * scheduled, the in-flight step's outcome is discarded, and the abort
 * (reason: the RC5011 error) reaches that step through its StepContext
 * `signal` so cancellation-aware IO stops instead of running to
 * completion in the background.
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
            nestedDeps(deps, segment, {
              rethrowUnhandled: true,
              abortSignal: abandon.signal,
            }),
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
        const timeoutError = rcError("RC5011", undefined, {
          message: `Route "${deps.routeId}" pipeline exceeded its ${timeoutMs}ms timeout`,
        });
        // Stop the abandoned run: the scheduling loop stops queueing
        // further steps, and the in-flight step sees the abort via its
        // StepContext signal (exposed by the nested run's stepContext)
        // so cancellation-aware IO stops instead of running to
        // completion with a discarded outcome. The RC5011 error rides
        // as the abort reason.
        abandon.abort(timeoutError);
        deps.context.emit("route:timeout:expired", {
          ...scoped,
          elapsed: Date.now() - start,
        });
        throw timeoutError;
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
    async execute(exchange, ctx) {
      const abandon = ctx?.signal ?? deps.abortSignal;
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
      // A resumed continuation may retry: each attempt must re-enter the
      // suspending step with the same parked state, even though a settled
      // step inside a prior attempt already cleared it (a later step's
      // retryable failure would otherwise re-run the agent from scratch).
      const resumeSnapshot = peekResumeStepState(exchange);
      const result = await executeWithRetry(
        () => {
          if (resumeSnapshot !== undefined) {
            setResumeStepState(exchange, resumeSnapshot);
          }
          return runPipeline(
            nestedDeps(deps, segment, {
              rethrowUnhandled: true,
              abortSignal: abandon,
            }),
            exchange,
            Date.now(),
          );
        },
        options,
        {
          // Intake, not execution. A backoff cut short surfaces the last
          // error as a proper terminal outcome; waiting it out burns the
          // shutdown deadline on attempts that cannot finish and ends in an
          // abandonment that emits no terminal event at all. An abandoned
          // run must also stop sleeping between attempts, hence `abandon`:
          // a backoff outlives the deadline that abandoned it.
          signal: anySignal(deps.route.intakeSignal, abandon),
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
    async execute(exchange, ctx) {
      const abandon = ctx?.signal ?? deps.abortSignal;
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

      const forward = deps.buildForward(exchange);

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
              nestedDeps(deps, segment, {
                rethrowUnhandled: true,
                abortSignal: abandon,
              }),
              exchange,
              Date.now(),
            ),
          ),
      );
    },
  };
}

/**
 * Build a route-scope `.concurrency()` bulkhead segment step, the
 * INNERMOST resilience layer (inside retry / timeout). Acquires a slot
 * (queueing or fast-failing per mode), runs the chain tail via a nested
 * executor invocation, and releases the slot when that run settles, so a
 * slot is held only for the actual attempt and freed between retry
 * backoffs. A `reject`-mode or queue-full rejection throws `RC5026`, which
 * an outer `.retry()` (sitting outside this segment) can re-attempt.
 *
 * `skipStepEvents: true` keeps `runPipeline` from emitting generic
 * lifecycle events; the segment emits its own `route:concurrency:*` family
 * with `scope: "route"`.
 */
function buildConcurrencySegmentStep(
  deps: ExecutorDeps,
  segment: Step<Adapter>[],
  controller: ConcurrencyController,
): Step<Adapter> {
  return {
    operation: OperationType.CONCURRENCY,
    label: "concurrency",
    adapter: CONCURRENCY_SEGMENT_ADAPTER,
    skipStepEvents: true,
    async execute(exchange, ctx) {
      // The segment step is built once, when the chain is assembled, but an
      // abandon signal belongs to a single execution: an outer `.timeout()`
      // mints a fresh controller per attempt and hands it down through the
      // step context. Reading it from the build-time `deps` would always
      // read the signal that existed before any attempt started.
      const abandon = ctx?.signal ?? deps.abortSignal;
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      const scoped: ConcurrencyEventScope = {
        routeId: deps.routeId,
        exchangeId: exchange.id,
        correlationId,
        stepLabel: "route",
        scope: "route",
        ...(controller.label !== undefined ? { label: controller.label } : {}),
      };

      return executeWithConcurrency(
        controller,
        exchange,
        deps.route,
        {
          // Intake: a queued segment step is released as soon as shutdown
          // begins and admitted with a no-op release (see `#joinWaitLine`),
          // so the drain runs it instead of leaving it parked behind a slot
          // that will never free. Also cancelled when an outer segment
          // abandons this attempt (e.g. a route-scope timeout firing while
          // this exchange is still parked in the bulkhead queue).
          signal: anySignal(deps.route.intakeSignal, abandon),
          ...concurrencyEmitHooks(deps.context, scoped, true),
        },
        async () =>
          segmentResultToOutcome(
            await runPipeline(
              nestedDeps(deps, segment, {
                rethrowUnhandled: true,
                abortSignal: abandon,
              }),
              exchange,
              Date.now(),
            ),
          ),
        { mustWait: deps.admissionMustWait === true },
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
