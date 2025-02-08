import type {
  Exchange,
  Processor,
  Splitter,
  Destination,
  Source,
  CraftContext,
  ExchangeHeaders,
} from "@routecraft/core";
import { ContextBuilder, RouteBuilder } from "@routecraft/core";
import {
  ChannelAdapter,
  type ChannelAdapterOptions,
  LogAdapter,
  NoopAdapter,
  SimpleAdapter,
  TimerAdapter,
  type TimerOptions,
} from "@routecraft/adapters";
import { OperationType } from "@routecraft/core";

export function context(): ContextBuilder {
  return new ContextBuilder();
}

export function routes(): RouteBuilder {
  return new RouteBuilder();
}

export function simple<T = unknown>(
  producer: (() => T | Promise<T>) | T,
): SimpleAdapter<T> {
  return new SimpleAdapter<T>(
    typeof producer === "function"
      ? (producer as () => T | Promise<T>)
      : () => producer,
  );
}

export function noop<T = unknown>(): NoopAdapter<T> {
  return new NoopAdapter<T>();
}

export function log<T = unknown>(): LogAdapter<T> {
  return new LogAdapter<T>();
}

export function channel<T = unknown>(
  channel: string,
  options?: Partial<ChannelAdapterOptions>,
): ChannelAdapter<T> {
  return new ChannelAdapter<T>(channel, options);
}

export function timer(options?: TimerOptions): TimerAdapter {
  return new TimerAdapter(options);
}

export function source<T = unknown>(
  fn: (
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ) => void | Promise<void>,
): Source<T> {
  return {
    adapterId: "routecraft.adapter.anonymous.source",
    subscribe: fn,
  };
}

export function processor<T = unknown>(
  fn: (exchange: Exchange<T>) => Promise<Exchange<T>> | Exchange<T>,
): Processor<T> {
  return {
    adapterId: "routecraft.adapter.anonymous.processor",
    process: fn,
  };
}

export function splitter<T, R>(
  fn: (exchange: Exchange<T>) => Promise<Exchange<R>[]> | Exchange<R>[],
): Splitter {
  return {
    adapterId: "routecraft.adapter.anonymous.splitter",
    split: fn,
  };
}

export function aggregator<T = unknown, R = unknown>(
  fn: (exchanges: Exchange<T>[]) => Promise<Exchange<R>> | Exchange<R>,
) {
  return {
    adapterId: "routecraft.adapter.anonymous.aggregator",
    operation: OperationType.AGGREGATE,
    aggregate: fn,
  };
}

export function destination<T = unknown>(
  fn: (exchange: Exchange<T>) => Promise<void> | void,
): Destination<T> {
  return {
    adapterId: "routecraft.adapter.anonymous.destination",
    send: fn,
  };
}
