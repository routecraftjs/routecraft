import { type Adapter, type Step } from "../types.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  OperationType,
} from "../exchange.ts";

/**
 * Function form of a processor: receives the full exchange and returns a (possibly new) exchange.
 * Use with `.process(processor)`. Prefer pure logic; use `.to()` for IO side effects.
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
 * Step that runs a processor on the full exchange. The returned exchange's body and headers replace the current ones.
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
    const newExchange = await Promise.resolve(this.adapter.process(exchange));
    // Process adapter may return a modified exchange; copy properties to original
    exchange.body = newExchange.body as unknown as T;
    (exchange as { headers: ExchangeHeaders }).headers = newExchange.headers;
    queue.push({
      exchange: exchange as unknown as Exchange<R>,
      steps: remainingSteps,
    });
  }
}
