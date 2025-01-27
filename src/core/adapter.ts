import { type CraftContext } from "./context.ts";
import { type Exchange, type ExchangeHeaders } from "./exchange.ts";

export interface Source<T = unknown> {
  subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<void>,
  ): Promise<() => void>;
}

export interface Destination<T = unknown> {
  send(exchange: Exchange<T>): Promise<void>;
}

export interface Adapter<T = unknown> extends Source<T>, Destination<T> {}
