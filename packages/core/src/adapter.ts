import { type CraftContext } from "./context.ts";
import { type Exchange, type ExchangeHeaders } from "./exchange.ts";

export interface Adapter {
  readonly adapterId: string;
}

export interface Aggregator<T = unknown, R = unknown> extends Adapter {
  aggregate(exchanges: Exchange<T>[]): Promise<Exchange<R>> | Exchange<R>;
}

export interface Source<T = unknown> extends Adapter {
  subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ): Promise<void> | void;
}

export interface Processor<T = unknown> extends Adapter {
  process(exchange: Exchange<T>): Promise<Exchange<T>> | Exchange<T>;
}

export interface Destination<T = unknown> extends Adapter {
  send(exchange: Exchange<T>): Promise<void> | void;
}

export interface Splitter<T = unknown, R = unknown> extends Adapter {
  split(exchange: Exchange<T>): Promise<Exchange<R>[]> | Exchange<R>[];
}
