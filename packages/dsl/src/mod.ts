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
