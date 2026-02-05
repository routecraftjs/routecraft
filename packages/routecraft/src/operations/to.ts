import { type Adapter, type Step } from "../types.ts";
import { type Exchange, OperationType } from "../exchange.ts";

/**
 * To (Destination): sends exchange to a destination and replaces body with result if defined.
 * - If result is undefined, keeps exchange unchanged
 * - If result is defined, replaces exchange.body with result
 * - Use for IO boundaries (DB writes, HTTP emits, queues)
 */

export type CallableDestination<T = unknown, R = void> = (
  exchange: Exchange<T>,
) => Promise<R> | R;

export interface Destination<T = unknown, R = void> extends Adapter {
  send: CallableDestination<T, R>;
}

export class ToStep<T = unknown, R = void> implements Step<Destination<T, R>> {
  operation: OperationType = OperationType.TO;
  adapter: Destination<T, R>;

  constructor(adapter: Destination<T, R> | CallableDestination<T, R>) {
    this.adapter = typeof adapter === "function" ? { send: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<T>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    // Call the destination and capture the result
    const result = await Promise.resolve(this.adapter.send(exchange));

    // If result is defined, replace body with result
    if (result !== undefined) {
      exchange.body = result as T;
    }

    // Push the exchange to the queue
    queue.push({ exchange, steps: remainingSteps });
  }
}
