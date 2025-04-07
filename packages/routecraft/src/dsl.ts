import { ContextBuilder, RouteBuilder } from "./builder.ts";
import { SimpleAdapter } from "./adapters/simple.ts";
import { NoopAdapter } from "./adapters/noop.ts";
import { LogAdapter } from "./adapters/log.ts";
import {
  ChannelAdapter,
  type ChannelAdapterOptions,
} from "./adapters/channel.ts";
import { TimerAdapter, type TimerOptions } from "./adapters/timer.ts";

/**
 * Create a new context builder.
 *
 * This is the entry point for creating a new application context.
 *
 * @returns A new ContextBuilder instance
 *
 * @example
 * ```typescript
 * // Create and configure a context
 * const ctx = context()
 *   .routes(myRoute)
 *   .onStartup(() => console.log('Starting...'))
 *   .build();
 *
 * // Start processing
 * await ctx.start();
 * ```
 */
export function context(): ContextBuilder {
  return new ContextBuilder();
}

/**
 * Create a new route builder.
 *
 * This is the entry point for defining routes in a fluent way.
 *
 * @returns A new RouteBuilder instance
 *
 * @example
 * ```typescript
 * // Define a route that processes data
 * const myRoute = routes()
 *   .from(simple("Hello, World!"))
 *   .transform(data => data.toUpperCase())
 *   .to(log())
 *   .build();
 * ```
 */
export function routes(): RouteBuilder {
  return new RouteBuilder();
}

/**
 * Create a simple adapter that produces static or dynamically generated data.
 *
 * This adapter can be used as a source in a route to provide data.
 *
 * @template T The type of data to produce
 * @param producer A static value or function that produces a value
 * @returns A SimpleAdapter instance
 *
 * @example
 * ```typescript
 * // Static data
 * routes().from(simple("Hello, World!"))
 *
 * // Dynamic data from a function
 * routes().from(simple(() => new Date().toISOString()))
 *
 * // Dynamic data from an async function
 * routes().from(simple(async () => {
 *   const response = await fetch('https://api.example.com/data');
 *   return response.json();
 * }))
 * ```
 */
export function simple<T = unknown>(
  producer: (() => T | Promise<T>) | T,
): SimpleAdapter<T> {
  return new SimpleAdapter<T>(
    typeof producer === "function"
      ? (producer as () => T | Promise<T>)
      : () => producer,
  );
}

/**
 * Create a no-operation adapter that does nothing.
 *
 * This can be useful for testing or as a placeholder.
 *
 * @template T The type of data this adapter processes
 * @returns A NoopAdapter instance
 *
 * @example
 * ```typescript
 * // Send to a no-op destination during development
 * routes()
 *   .from(source)
 *   .to(process.env.PROD ? realDestination() : noop())
 * ```
 */
export function noop<T = unknown>(): NoopAdapter<T> {
  return new NoopAdapter<T>();
}

/**
 * Create a logging adapter that logs messages to the console.
 *
 * This is useful for debugging and monitoring data flow in routes.
 *
 * @template T The type of data this adapter processes
 * @returns A LogAdapter instance
 *
 * @example
 * ```typescript
 * // Log data at different points in the route
 * routes()
 *   .from(source)
 *   .tap(log()) // Log input data
 *   .transform(data => processData(data))
 *   .tap(log()) // Log transformed data
 *   .to(destination)
 * ```
 */
export function log<T = unknown>(): LogAdapter<T> {
  return new LogAdapter<T>();
}

/**
 * Create a channel adapter for inter-route communication.
 *
 * Channel adapters allow routes to communicate with each other
 * by sending and receiving messages on named channels.
 *
 * @template T The type of data this adapter processes
 * @param channel The name of the channel to use
 * @param options Optional configuration for the channel adapter
 * @returns A ChannelAdapter instance
 *
 * @example
 * ```typescript
 * // Producer route sends to a channel
 * const producerRoute = routes()
 *   .from(source)
 *   .to(channel('my-channel'))
 *   .build();
 *
 * // Consumer route reads from the same channel
 * const consumerRoute = routes()
 *   .from(channel('my-channel'))
 *   .to(destination)
 *   .build();
 *
 * // Register both routes with the context
 * context().routes([producerRoute, consumerRoute]).build();
 * ```
 */
export function channel<T = unknown>(
  channel: string,
  options?: Partial<ChannelAdapterOptions>,
): ChannelAdapter<T> {
  return new ChannelAdapter<T>(channel, options);
}

/**
 * Create a timer adapter that produces messages at regular intervals.
 *
 * This adapter can be used as a source in a route to trigger processing
 * on a schedule.
 *
 * @param options Configuration for the timer
 * @returns A TimerAdapter instance
 *
 * @example
 * ```typescript
 * // Run every 5 seconds
 * routes()
 *   .from(timer({ intervalMs: 5000 }))
 *   .to(periodicTask)
 *   .build();
 *
 * // Run 10 times, once per second
 * routes()
 *   .from(timer({ intervalMs: 1000, repeatCount: 10 }))
 *   .to(batchTask)
 *   .build();
 * ```
 */
export function timer(options?: TimerOptions): TimerAdapter {
  return new TimerAdapter(options);
}
