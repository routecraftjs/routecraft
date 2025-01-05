import { Destination, type Exchange } from "@routecraft/core";

export class NoopDestination implements Destination {
  async send(_exchange: Exchange): Promise<void> {}
}
