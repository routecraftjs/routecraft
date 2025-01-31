import type { Exchange, Processor } from "@routecraft/core";
import { ContextBuilder, RouteBuilder } from "@routecraft/core";
import {
  ChannelAdapter,
  type ChannelAdapterOptions,
  LogAdapter,
  NoopAdapter,
  SimpleAdapter,
} from "@routecraft/adapters";

export function processor(fn: (exchange: Exchange) => Exchange): Processor {
  return {
    process: fn,
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
