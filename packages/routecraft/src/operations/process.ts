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
    // Honour what the user returned. If they returned a `DefaultExchange`
    // instance directly (e.g. `new DefaultExchange(...)` or the same `ex`
    // they were given), use it as-is. Otherwise they returned a plain
    // spread (`{ ...ex, body: x }`) which has no framework internals;
    // re-wrap it onto the previous exchange's context binding.
    //
    // Principal follows `?? prev.principal` semantics inside `rewrap`: a
    // returned exchange that omits the principal inherits the parent's,
    // matching the previous behaviour and keeping parity with split /
    // aggregate / enrich / tap.
    const next =
      returned instanceof DefaultExchange
        ? (returned as DefaultExchange<R>)
        : DefaultExchange.rewrap<R>(exchange, {
            id: returned.id,
            body: returned.body,
            headers: returned.headers,
            ...(returned.principal !== undefined && {
              principal: returned.principal,
            }),
          });
    queue.push({ exchange: next, steps: remainingSteps });
  }
}
