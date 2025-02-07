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

export function simple(
  producer: () => unknown | Promise<unknown>,
): SimpleAdapter {
  return new SimpleAdapter(producer);
}

export function noop(): NoopAdapter {
  return new NoopAdapter();
}

export function log(): LogAdapter {
  return new LogAdapter();
}

export function channel(
  channel: string,
  options?: Partial<ChannelAdapterOptions>,
): ChannelAdapter {
  return new ChannelAdapter(channel, options);
}

export function timer(options?: TimerOptions): TimerAdapter {
  return new TimerAdapter(options);
}

export function source<T>(
  fn: (
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<void>,
    abortController: AbortController,
  ) => void | Promise<void>,
): Source {
  return {
    adapterId: "routecraft.adapter.anonymous.source",
    subscribe: fn,
  };
}

export function processor<T>(
  fn: (exchange: Exchange<T>) => Promise<Exchange<T>> | Exchange<T>,
): Processor {
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

export function destination<T>(
  fn: (exchange: Exchange<T>) => Promise<void> | void,
): Destination {
  return {
    adapterId: "routecraft.adapter.anonymous.destination",
    send: fn,
  };
}
