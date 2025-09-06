import { type Adapter, type Step } from "../types.ts";
import { type Exchange, OperationType } from "../exchange.ts";

/**
 * To (Destination): side effects/output only.
 * - Sends or persists the current exchange
 * - Must not modify the message; downstream continues unchanged
 * - Use for IO boundaries (DB writes, HTTP emits, queues)
 */

export type CallableDestination<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<void> | void;

export interface Destination<T = unknown> extends Adapter {
  send: CallableDestination<T>;
}

export class ToStep<T = unknown> implements Step<Destination<T>> {
  operation: OperationType = OperationType.TO;
  adapter: Destination<T>;

  constructor(adapter: Destination<T> | CallableDestination<T>) {
    this.adapter = typeof adapter === "function" ? { send: adapter } : adapter;
  }

  async execute(
    exchange: Exchange<T>,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange<T>; steps: Step<Adapter>[] }[],
  ): Promise<void> {
    await this.adapter.send(exchange);
    queue.push({ exchange, steps: remainingSteps });
  }
}
