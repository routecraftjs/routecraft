import type { Destination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";

/**
 * NoopDestinationAdapter discards messages without side effects.
 */
export class NoopDestinationAdapter<T = unknown> implements Destination<T> {
  readonly adapterId = "routecraft.adapter.noop";

  send(exchange: Exchange<T>): Promise<void> {
    const adapterLabel = this.adapterId.split(".").pop();
    exchange.logger.debug(
      { adapter: adapterLabel },
      "Discarding message (noop)",
    );
    return Promise.resolve();
  }
}
