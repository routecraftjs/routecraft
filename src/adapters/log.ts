import {
  type Destination,
  type Exchange,
  type Processor,
} from "@routecraft/core";

export class LogAdapter implements Destination, Processor {
  send(exchange: Exchange): Promise<void> {
    this.log(exchange);
    return Promise.resolve();
  }

  process(exchange: Exchange): Promise<Exchange> {
    this.log(exchange);
    return Promise.resolve(exchange);
  }

  private log(exchange: Exchange): void {
    const { id, body, headers } = exchange;
    console.log("Logging Exchange", { id, body, headers });
  }
}
