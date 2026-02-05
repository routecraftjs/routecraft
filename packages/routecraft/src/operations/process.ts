import { type Adapter, type Step } from "../types.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  OperationType,
} from "../exchange.ts";

/**
 * Processor: mutate or derive a new Exchange from the current one.
 * - May change body, headers, and type
 * - Prefer pure logic; avoid side effects (use `.to(...)` for IO)
 * - Use when you need access to headers or want to replace the whole exchange
 */

export type CallableProcessor<T = unknown, R = T> = (
  exchange: Exchange<T>,
) => Promise<Exchange<R>> | Exchange<R>;

export interface Processor<T = unknown, R = T> extends Adapter {
  process: CallableProcessor<T, R>;
}

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
