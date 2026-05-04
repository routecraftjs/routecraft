import { type Adapter, type Step } from "../types.ts";
import { type Exchange, OperationType, DefaultExchange } from "../exchange.ts";

/**
 * Function form of a processor: receives the full exchange and returns a new
 * exchange. Use with `.process(processor)`. Prefer pure logic; use `.to()`
 * for IO side effects.
 *
 * The returned exchange must be a new value; the parameter is `Readonly<>`
 * and the framework will TypeError if user code reassigns its fields. Build
 * the result via spread:
 *
 * ```ts
 * .process((ex) => ({
 *   ...ex,
 *   body: { ...ex.body, hello: "world" },
 *   headers: { ...ex.headers, "x-tag": "v" },
 * }))
 * ```
 *
 * The framework re-wraps a plain spread back into a proper exchange instance
 * via {@link DefaultExchange.rewrap}, preserving the internal context binding.
 *
 * @template T - Current body type
 * @template R - Result body type (default T)
 */
export type CallableProcessor<T = unknown, R = T> = (
  exchange: Exchange<T>,
) => Promise<Exchange<R>> | Exchange<R>;

/**
 * Processor adapter: transforms the whole exchange (body, headers). Used with `.process()`.
 * Use when you need headers or full exchange; use `.transform()` for body-only mapping.
 *
 * @template T - Current body type
 * @template R - Result body type
 */
export interface Processor<T = unknown, R = T> extends Adapter {
  process: CallableProcessor<T, R>;
}

/**
 * Step that runs a processor on the full exchange. The returned exchange's
 * body and headers replace the current ones; identity (id, internals) is
 * preserved by the framework.
 */
export class ProcessStep<T = unknown, R = T> implements Step<Processor<T, R>> {
  operation: OperationType = OperationType.PROCESS;
  adapter: Processor<T, R>;

  constructor(adapter: Processor<T, R> | CallableProcessor<T, R>) {
    this.adapter =
      typeof adapter === "function" ? { process: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<R>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    const returned = await Promise.resolve(this.adapter.process(exchange));
    // The fast path is identity equality (the user returned the same `ex`
    // they were given). For anything else -- a plain spread, a freshly
    // constructed `DefaultExchange`, or even an exchange built against a
    // foreign context -- always rewrap onto THIS exchange's internals.
    // An `instanceof DefaultExchange` fast-path would let a user return
    // `new DefaultExchange(otherContext, ...)` and break route binding
    // for downstream telemetry / split / tap; rewrap restores it. This
    // also keeps the principal sticky-set rule (`?? prev.principal`)
    // consistent regardless of return shape.
    //
    // We do NOT forward `returned.id` into rewrap. `.process()` is a body
    // transform; identity is owned by the framework. A user who returns
    // `new DefaultExchange(ctx, ...)` (with a fresh UUID) inside a
    // processor must not silently change the exchange id mid-route, or
    // event correlation, split bookkeeping, and child telemetry break.
    // Identity-changing operations (split, aggregate) have dedicated
    // paths.
    const next =
      returned === (exchange as unknown as Exchange<R>)
        ? (exchange as unknown as Exchange<R>)
        : DefaultExchange.rewrap<R>(exchange, {
            body: returned.body,
            headers: returned.headers,
            ...(returned.principal !== undefined && {
              principal: returned.principal,
            }),
          });
    queue.push({ exchange: next, steps: remainingSteps });
  }
}
