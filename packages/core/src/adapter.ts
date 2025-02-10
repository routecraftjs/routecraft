import { type CraftContext } from "./context.ts";
import { type Exchange, type ExchangeHeaders } from "./exchange.ts";

// eslint-disable-next-line
export interface Adapter {}

export type CallableSource<T = unknown> = (
  context: CraftContext,
  handler: (message: T, headers?: ExchangeHeaders) => Promise<void>,
  abortController: AbortController,
) => Promise<void> | void;

export interface Source<T = unknown> extends Adapter {
  subscribe: CallableSource<T>;
}

export type CallableProcessor<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<Exchange<T>> | Exchange<T>;

export interface Processor<T = unknown> extends Adapter {
  process: CallableProcessor<T>;
}

export type CallableDestination<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<void> | void;

export interface Destination<T = unknown> extends Adapter {
  send: CallableDestination<T>;
}

export type CallableSplitter<T = unknown, R = unknown> = (
  exchange: Exchange<T>,
) => Promise<Exchange<R>[]> | Exchange<R>[];

export interface Splitter<T = unknown, R = unknown> extends Adapter {
  split: CallableSplitter<T, R>;
}

export type CallableAggregator<T = unknown, R = unknown> = (
  exchanges: Exchange<T>[],
) => Promise<Exchange<R>> | Exchange<R>;

export interface Aggregator<T = unknown, R = unknown> extends Adapter {
  aggregate: CallableAggregator<T, R>;
}

export type CallableTransformer<T = unknown> = (message: T) => Promise<T> | T;

export interface Transformer<T = unknown> extends Adapter {
  transform: CallableTransformer<T>;
}

export type CallableTap<T = unknown> = (
  exchange: Exchange<T>,
) => Promise<void> | void;

export interface Tap<T = unknown> extends Adapter {
  tap: CallableTap<T>;
}
