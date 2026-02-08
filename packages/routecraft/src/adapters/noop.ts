import { type Destination } from "../operations/to";
import { type Exchange } from "../exchange";

/**
 * Create a no-operation adapter that does nothing.
 *
 * This can be useful for testing or as a placeholder.
 *
 * @template T The type of data this adapter processes
 * @returns A NoopAdapter instance
 */
export function noop<T = unknown>(): NoopAdapter<T> {
  return new NoopAdapter<T>();
}

export class NoopAdapter<T = unknown> implements Destination<T> {
  readonly adapterId = "routecraft.adapter.noop";

  send(exchange: Exchange<T>): Promise<void> {
    exchange.logger.debug({ id: exchange.id }, "Discarding message");
    return Promise.resolve();
  }
}
