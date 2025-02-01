import { type CraftContext } from "./context.ts";
import { type Exchange, type ExchangeHeaders } from "./exchange.ts";

export interface Adapter {
  readonly adapterId: string;
}

export type Source<T = unknown> = Adapter & {
  subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void>;
};

export type Processor<T = unknown> = Adapter & {
  process(exchange: Exchange<T>): Promise<Exchange<T>> | Exchange<T>;
};

export type Destination<T = unknown> = Adapter & {
  send(exchange: Exchange<T>): Promise<void>;
};
