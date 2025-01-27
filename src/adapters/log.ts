import { Destination, type Exchange } from "@routecraft/core";

export class LogDestination implements Destination {
  send(exchange: Exchange): Promise<void> {
    const { id, body, headers } = exchange;
    console.log("Logging Exchange", { id, body, headers });
    return Promise.resolve();
  }
}
