import { type CraftContext } from "./context.ts";
import { type Exchange, type ExchangeHeaders } from "./exchange.ts";

export type Source<T = unknown> = {
  subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<void>,
  ): Promise<() => void>;
};

export type Processor = {
  process(exchange: Exchange): Promise<Exchange> | Exchange;
};

export type Destination<T = unknown> = {
  send(exchange: Exchange<T>): Promise<void>;
};
