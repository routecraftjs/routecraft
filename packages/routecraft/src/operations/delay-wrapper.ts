import {
  type Exchange,
  getExchangeContext,
  getExchangeRoute,
  HeadersKeys,
} from "../exchange.ts";
import type { Adapter, Step, StepContext, StepOutcome } from "../types.ts";
import { WrapperStep } from "./wrapper.ts";
import { cancellableSleep, SleepAbortedError } from "./cancellable-sleep.ts";

/**
 * Step-scope `.delay()` wrapper. Waits a fixed time, then runs the
 * wrapped step. Pass-through: the exchange is unchanged by the wait.
 *
 * The wait is tied to the route's abort signal: when the route shuts
 * down mid-wait, the remaining wait is skipped and the wrapped step
 * still runs, so no exchange is silently dropped by a shutdown. The
 * `route:delay:stopped` event carries `cancelled: true` in that case.
 *
 * Step scope only: there is no route-scope form. A route-scope delay
 * would be equivalent to a delay before the first step, so the
 * builder does not stage one (see `.standards/resilience-wrappers.md`
 * and the pre-from filter chain, which reserves no slot for delay).
 *
 * Emits scope-aware lifecycle events:
 * - `route:delay:started` when the wait begins.
 * - `route:delay:stopped` when the wait ends (elapsed, cancelled flag).
 */
export class DelayWrapperStep<
  T extends Adapter = Adapter,
> extends WrapperStep<T> {
  constructor(
    inner: Step<T>,
    private readonly delayMs: number,
  ) {
    super(inner);
  }

  protected override async runInner(
    exchange: Exchange,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const route = getExchangeRoute(exchange);
    const context = getExchangeContext(exchange);
    const routeId = route?.definition.id;
    const stepLabel = this.label ?? String(this.operation);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    const shouldEmit = route && context && routeId;

    if (shouldEmit) {
      context.emit("route:delay:started", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        stepLabel,
        scope: "step",
        delayMs: this.delayMs,
      });
    }

    const start = Date.now();
    let cancelled = false;
    try {
      await cancellableSleep(this.delayMs, route?.signal);
    } catch (err) {
      if (!(err instanceof SleepAbortedError)) throw err;
      // Route shutdown: skip the remaining wait but still run the
      // wrapped step. Cancellation cuts the wait short; it never drops
      // the exchange.
      cancelled = true;
    }

    if (shouldEmit) {
      context.emit("route:delay:stopped", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        stepLabel,
        scope: "step",
        delayMs: this.delayMs,
        elapsed: Date.now() - start,
        cancelled,
      });
    }

    return await this.inner.execute(exchange, ctx);
  }
}
