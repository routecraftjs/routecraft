import { Destination, type Exchange } from "@routecraft/core";

export class LogDestination implements Destination {
  send(exchange: Exchange): Promise<void> {
    console.log("Logging Exchange", exchange);
    return Promise.resolve();
  }
}
