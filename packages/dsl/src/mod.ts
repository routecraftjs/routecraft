import type {
  Exchange,
  Processor,
  Splitter,
  Destination,
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

export function processor<T>(
  fn: (exchange: Exchange<T>) => Promise<Exchange<T>> | Exchange<T>,
): Processor {
  return {
    adapterId: "routecraft.adapter.anonymous",
    process: fn,
  };
}

export function splitter<T, R>(
  fn: (exchange: Exchange<T>) => Promise<Exchange<R>[]> | Exchange<R>[],
): Splitter {
  return {
    adapterId: "routecraft.adapter.anonymous",
    split: fn,
  };
}

export function destination<T>(
  fn: (exchange: Exchange<T>) => Promise<void> | void,
): Destination {
  return {
    adapterId: "routecraft.adapter.anonymous",
    send: fn,
  };
}
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

export function split<T = unknown, R = unknown>(
  splitter: (exchange: Exchange<T>) => Promise<Exchange<R>[]> | Exchange<R>[],
) {
  return {
    adapterId: "routecraft.adapter.split",
    operation: OperationType.SPLIT,
    split: splitter,
  };
}
