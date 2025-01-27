import {
  type DefaultExchange,
  Destination,
  type Exchange,
} from "@routecraft/core";

export class LogDestination implements Destination {
  send(exchange: Exchange): Promise<void> {
    const { context: _, ...logData } = exchange as DefaultExchange;
    console.log("Logging Exchange", logData);
    return Promise.resolve();
  }
}
