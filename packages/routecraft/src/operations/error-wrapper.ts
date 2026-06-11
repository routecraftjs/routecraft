import {
  type Exchange,
  getExchangeContext,
  getExchangeRoute,
  HeadersKeys,
  DefaultExchange,
  markDropped,
} from "../exchange.ts";
import { rcError, RoutecraftError } from "../error.ts";
import { isRoutecraftError } from "../brand.ts";
import { isRecovery } from "../recovery.ts";
import type { ErrorHandler } from "../route.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import { WrapperStep } from "./wrapper.ts";

/**
 * Step-scope `.error()` handler. Wraps a single step. On wrapped-step
 * success the pipeline continues unchanged; on wrapped-step failure
 * the user-supplied handler runs, its return value replaces
 * `exchange.body`, and the pipeline continues with the next step.
 *
 * Mirrors the route-level `errorHandler` semantics (`(err, exchange,
 * forward) => unknown`), but bound to one step instead of the whole
 * pipeline. The handler receives the same `forward` callable as the
 * route-level handler, so a step-scope handler can delegate recovery
 * to a direct route the same way:
 *
 * ```ts
 * .error((err, ex, forward) => forward('errors.dlq', ex.body))
 * .to(http({ url: 'https://flaky.api/x' }))
 * ```
 *
 * If the handler itself throws, the wrapper rethrows so the route's
 * outer catch in `runPipeline` fires the route-level handler when one is
 * defined, or the default `route:*:error` / `context:error` /
 * `exchange:failed` path otherwise. The route is NOT stopped.
 *
 * Emits scope-aware lifecycle events:
 * - `route:error-handler:invoked`  ({ scope: "step", stepLabel })
 * - `route:error-handler:recovered` on handler success
 * - `route:error-handler:failed`    on handler throw (rethrown)
 */
export class ErrorWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  constructor(
    inner: Step<T>,
    private readonly handler: ErrorHandler,
  ) {
    super(inner);
  }

  protected override async runInner(
    exchange: Exchange,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const route = getExchangeRoute(exchange);
    const context = getExchangeContext(exchange);
    const stepLabel = this.label ?? String(this.operation);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;

    // Run the inner step and pass its outcome through unchanged on
    // success. The inner never sees the work queue, so a failure here
    // has scheduled nothing; recovery simply substitutes an outcome.
    try {
      return await this.inner.execute(exchange, ctx);
    } catch (rawInnerError) {
      // Normalise the thrown value to `RoutecraftError` so the
      // step-scope handler receives the same shape the route-scope
      // handler does (route.ts's `processError` does the same).
      // Handlers that branch on `error.rc` / `error.meta.message`
      // work in both positions without special-casing.
      const innerError: RoutecraftError = isRoutecraftError(rawInnerError)
        ? (rawInnerError as RoutecraftError)
        : rcError("RC5001", rawInnerError, {
            message:
              rawInnerError instanceof Error
                ? rawInnerError.message
                : String(rawInnerError),
          });
      const routeId = route?.definition.id;
      if (route && context && routeId) {
        context.emit("route:error-handler:invoked", {
          routeId,
          exchangeId: exchange.id,
          correlationId,
          originalError: innerError,
          failedOperation: stepLabel,
          scope: "step",
          stepLabel,
        });
      }

      try {
        const forward = route?.getForward();
        if (!forward) {
          // Should not happen in normal pipelines (route is always
          // bound), but fail loudly rather than silently mis-recover.
          throw rcError("RC5001", innerError, {
            message:
              "Step-scope .error() handler ran without a route binding; cannot build forward()",
          });
        }
        const recovered = await this.handler(innerError, exchange, forward);
        if (isRecovery(recovered)) {
          if (recovered.kind === "rethrow") {
            // Declarative equivalent of `throw error` inside the
            // handler: fall through to the handler-threw path below with
            // the original error so the route-level cascade fires.
            throw innerError;
          }
          // `recovery.drop()`: resolve the error by discarding the
          // exchange. Mark before emitting so subscribers observing the
          // event see `isDropped(exchange) === true`; the route engine
          // reads the flag to skip `exchange:completed`.
          markDropped(exchange);
          if (route && context && routeId) {
            context.emit("route:error-handler:recovered", {
              routeId,
              exchangeId: exchange.id,
              correlationId,
              originalError: innerError,
              failedOperation: stepLabel,
              recoveryStrategy: "step-error-handler",
              scope: "step",
              stepLabel,
            });
            context.emit("route:exchange:dropped", {
              routeId,
              exchangeId: exchange.id,
              correlationId,
              reason: recovered.reason,
              exchange,
            });
          }
          return { kind: "drop" };
        }
        // Build a recovered exchange (the original is frozen). Inheriting
        // identity / internals via rewrap keeps event correlation
        // (exchangeId, route binding) consistent across the recovery.
        const recoveredExchange = DefaultExchange.rewrap(exchange, {
          body: recovered,
        });

        if (route && context && routeId) {
          context.emit("route:error-handler:recovered", {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            originalError: innerError,
            failedOperation: stepLabel,
            recoveryStrategy: "step-error-handler",
            scope: "step",
            stepLabel,
          });
        }
        return { kind: "continue", exchange: recoveredExchange };
      } catch (handlerError) {
        if (route && context && routeId) {
          context.emit("route:error-handler:failed", {
            routeId,
            exchangeId: exchange.id,
            correlationId,
            originalError: innerError,
            failedOperation: stepLabel,
            recoveryStrategy: "step-error-handler",
            scope: "step",
            stepLabel,
          });
        }
        // Rethrow so `runPipeline` cascades to the route-level handler
        // (or the default error path when none is set). Wrap raw
        // throws in `RoutecraftError` for consistent observability;
        // pass-through if already an RoutecraftError.
        throw handlerError instanceof RoutecraftError
          ? handlerError
          : rcError("RC5001", handlerError, {
              message: `Step-scope .error() handler for "${stepLabel}" threw`,
            });
      }
    }
  }
}
