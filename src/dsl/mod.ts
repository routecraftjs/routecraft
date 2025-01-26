import {
  ContextBuilder,
  Exchange,
  Processor,
  RouteBuilder,
} from "@routecraft/core";
import {
  LogDestination,
  NoopDestination,
  SimpleSource,
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
): SimpleSource {
  return new SimpleSource(producer);
}

export function noop(): NoopDestination {
  return new NoopDestination();
}

export function log(): LogDestination {
  return new LogDestination();
}
