import { Destination, type Exchange } from "@routecraft/core";

export class LogDestination implements Destination {
  send(exchange: Exchange): Promise<void> {
    const { context: _, ...logData } = exchange;
    console.log("Logging Exchange", logData);
    return Promise.resolve();
  }
}
