import {
  type Exchange,
  getExchangeContext,
  getExchangeRoute,
  HeadersKeys,
} from "../exchange.ts";
import { rcError, RoutecraftError } from "../error.ts";
import type { ErrorHandler } from "../route.ts";
import type { Adapter, EventName, Step } from "../types.ts";
import { WrapperStep, type WrapperOutcome } from "./wrapper.ts";

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
 * outer catch in `runSteps` fires the route-level handler when one is
 * defined, or the default `route:*:error` / `context:error` /
 * `exchange:failed` path otherwise. The route is NOT stopped.
 *
 * Emits scope-aware lifecycle events:
 * - `route:<id>:error-handler:invoked`  ({ scope: "step", stepLabel })
 * - `route:<id>:error-handler:recovered` on handler success
 * - `route:<id>:error-handler:failed`    on handler throw (rethrown)
 *
 * @experimental Surfaced via the dual-mode `.error()` builder method.
 */
export class ErrorWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  private innerPushed: {
    exchange: Exchange;
    steps: Step<Adapter>[];
  }[] = [];

  constructor(
    inner: Step<T>,
    private readonly handler: ErrorHandler,
  ) {
    super(inner);
  }

  protected override async runInner(
    exchange: Exchange,
  ): Promise<WrapperOutcome> {
    const route = getExchangeRoute(exchange);
    const context = getExchangeContext(exchange);
    const stepLabel = this.label ?? String(this.operation);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;

    // Run the inner step against a private queue so we can capture
    // pushes (for split / choice / etc.) and re-relay them with
    // remainingSteps in the template method on success or recovery.
    this.innerPushed = [];
    try {
      await this.inner.execute(exchange, [], this.innerPushed);
      return "ok";
    } catch (innerError) {
      const routeId = route?.definition.id;
      if (route && context && routeId) {
        context.emit(`route:${routeId}:error-handler:invoked` as EventName, {
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
        exchange.body = recovered;
        // The recovery replaced the body; subsequent pipeline steps
        // see the new value. No inner-pushed children survive a
        // failure, so clear the buffer to let the template method
        // route the (single) recovered exchange forward.
        this.innerPushed = [];

        if (route && context && routeId) {
          context.emit(
            `route:${routeId}:error-handler:recovered` as EventName,
            {
              routeId,
              exchangeId: exchange.id,
              correlationId,
              originalError: innerError,
              failedOperation: stepLabel,
              recoveryStrategy: "step-error-handler",
              scope: "step",
              stepLabel,
            },
          );
        }
        return "recovered";
      } catch (handlerError) {
        if (route && context && routeId) {
          context.emit(`route:${routeId}:error-handler:failed` as EventName, {
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
        // Rethrow so `runSteps` cascades to the route-level handler
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

  protected override drainInnerQueue(): {
    exchange: Exchange;
    steps: Step<Adapter>[];
  }[] {
    return this.innerPushed;
  }
}
