import type { CraftContext } from "../context.ts";
import {
  type Exchange,
  HeadersKeys,
  DefaultExchange,
  EXCHANGE_INTERNALS,
  isDropped,
  markDropped,
  setStartedAt,
} from "../exchange.ts";
import { isRecovery } from "../recovery.ts";
import { SPLIT_PARENT_STORE } from "../operations/split.ts";
import { rcError, RoutecraftError } from "../error.ts";
import { isRoutecraftError } from "../brand.ts";
import {
  type Adapter,
  type Step,
  type StepContext,
  getAdapterLabel,
} from "../types.ts";
import { buildParseStep } from "./synthetic-steps.ts";
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
  >;
  buildForward(): ForwardFn;
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
  //   postParseFilters   -> .cache() check, future
  //                         .throttle() / .circuitBreaker() / .retry() /
  //                         .timeout() (positions 5-8 in the chain doc)
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
  const initialSteps: Step<Adapter>[] = [
    ...deps.definition.preParseFilters,
    ...(sourceParse
      ? [buildParseStep(sourceParse, sourceFailureMode, sourceValidate)]
      : []),
    ...deps.definition.postParseFilters,
    ...deps.definition.steps,
    ...deps.definition.postFromFilters,
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
            // exchange. Mark before emitting so subscribers observing the
            // event see `isDropped(exchange) === true`; the route engine
            // reads the flag to skip `exchange:completed`.
            markDropped(exchange);
            deps.context.emit("route:error-handler:recovered", {
              routeId: deps.routeId,
              exchangeId: exchange.id,
              correlationId,
              originalError: err,
              failedOperation: stepLabel,
              recoveryStrategy: "route-error-handler",
              scope: "route",
            });
            deps.context.emit("route:exchange:dropped", {
              routeId: deps.routeId,
              exchangeId: exchange.id,
              correlationId,
              reason: result.reason,
              exchange,
            });
            dropped = true;
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
