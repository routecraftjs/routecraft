import { type CraftContext } from "./context.ts";
import { type Exchange, type ExchangeHeaders } from "./exchange.ts";

export type Source<T = unknown> = {
  subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void>;
};

export type Processor<T = unknown> = {
  process(exchange: Exchange<T>): Promise<Exchange<T>> | Exchange<T>;
};

export type Destination<T = unknown> = {
  send(exchange: Exchange<T>): Promise<void>;
};
