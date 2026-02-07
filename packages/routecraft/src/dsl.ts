import { ContextBuilder, RouteBuilder } from "./builder.ts";
import { SimpleAdapter } from "./adapters/simple.ts";
import { NoopAdapter } from "./adapters/noop.ts";
import { LogAdapter, type LogOptions } from "./adapters/log.ts";
import {
  DirectAdapter,
  type DirectAdapterOptions,
  type DirectDestinationOptions,
  type DirectSourceOptions,
} from "./adapters/direct.ts";
import { TimerAdapter, type TimerOptions } from "./adapters/timer.ts";
import { FetchAdapter, type FetchOptions } from "./adapters/fetch.ts";
import { type Exchange } from "./exchange.ts";

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
 *   .on('contextStarting', () => console.log('Starting...'))
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
 * const myRoute = craft()
 *   .from(simple("Hello, World!"))
 *   .transform(data => data.toUpperCase())
 *   .to(log())
 * ```
 */
export function craft(): RouteBuilder {
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
 * craft().from(simple("Hello, World!"))
 *
 * // Dynamic data from a function
 * craft().from(simple(() => new Date().toISOString()))
 *
 * // Dynamic data from an async function
 * craft().from(simple(async () => {
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
 * craft()
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
 * @param formatter Optional function that takes an exchange and returns the value to log.
 *   If omitted, logs exchange ID, body, and headers.
 * @param options Optional configuration object with `level` (defaults to "info").
 * @returns A LogAdapter instance
 *
 * @example
 * ```typescript
 * // Log data at different points in the route
 * craft()
 *   .from(source)
 *   .tap(log()) // Log input data
 *   .transform(data => processData(data))
 *   .tap(log()) // Log transformed data
 *   .to(destination)
 *
 * // Log with custom formatter
 * craft()
 *   .from(source)
 *   .tap(log((ex) => `Exchange with id: ${ex.id}`))
 *   .tap(log((ex) => `Body: ${JSON.stringify(ex.body)}`))
 *   .to(destination)
 *
 * // Log at debug level
 * craft().from(source).tap(log(undefined, { level: 'debug' })).to(destination)
 *
 * // Log at warn level with formatter
 * craft().from(source).to(log((ex) => ex.body, { level: 'warn' }))
 *
 * // For convenience, use level-specific helpers: debug(), warn(), error(), etc.
 * craft().from(source).tap(debug()).to(destination)
 * ```
 */
export function log<T = unknown>(
  formatter?: (exchange: Exchange<T>) => unknown,
  options?: LogOptions,
): LogAdapter<T> {
  return new LogAdapter<T>(formatter, options);
}

/**
 * Create a logging adapter that logs at DEBUG level.
 * Convenience wrapper for log() with level pre-set to "debug".
 *
 * @template T The type of data this adapter processes
 * @param formatter Optional function that takes an exchange and returns the value to log
 * @param options Optional configuration (level is fixed to "debug")
 * @returns A LogAdapter instance
 *
 * @example
 * ```typescript
 * craft().from(source).tap(debug()).to(destination)
 * craft().from(source).tap(debug((ex) => ex.body)).to(destination)
 * ```
 */
export function debug<T = unknown>(
  formatter?: (exchange: Exchange<T>) => unknown,
  options?: Omit<LogOptions, "level">,
): LogAdapter<T> {
  return new LogAdapter<T>(formatter, { ...options, level: "debug" });
}

/**
 * Create a direct adapter for synchronous inter-route communication.
 *
 * Direct adapters allow routes to communicate with each other
 * synchronously with single consumer semantics.
 *
 * @template T The type of data this adapter processes
 * @param endpoint The name of the direct endpoint (string) or a function that
 *                 returns the endpoint name based on the exchange
 * @param options Optional configuration for the direct adapter
 * @returns A DirectAdapter instance
 *
 * @example
 * ```typescript
 * // Basic validation with Zod 4 (z.object strips extra fields)
 * import { z } from 'zod'
 *
 * craft()
 *   .from(direct('user-processor', {
 *     schema: z.object({
 *       userId: z.string().uuid(),
 *       action: z.enum(['create', 'update', 'delete'])
 *     })
 *   }))
 *   .process(processUser)
 * ```
 *
 * @example
 * ```typescript
 * // Strict validation - fail on extra fields (Zod 4)
 * craft()
 *   .from(direct('user-processor', {
 *     schema: z.strictObject({
 *       userId: z.string().uuid(),
 *       action: z.enum(['create', 'update', 'delete'])
 *     })
 *   }))
 *   .process(processUser)
 * ```
 *
 * @example
 * ```typescript
 * // Header validation - validate required headers, keep others (Zod 4)
 * craft()
 *   .from(direct('api-handler', {
 *     headerSchema: z.looseObject({
 *       'x-tenant-id': z.string().uuid(),
 *       'x-trace-id': z.string().optional(),
 *     })
 *   }))
 *   .process(handleRequest)
 * ```
 *
 * @example
 * ```typescript
 * // Discoverable route with metadata
 * craft()
 *   .from(direct('fetch-content', {
 *     description: 'Fetch and summarize web content from URL',
 *     schema: z.object({ url: z.string().url() }),
 *     keywords: ['fetch', 'web', 'scrape', 'summarize']
 *   }))
 *   .process(fetchAndSummarize)
 * ```
 *
 * @example
 * ```typescript
 * // Dynamic endpoint (destination only)
 * craft()
 *   .from(source)
 *   .to(direct((ex) => `handler-${ex.body.type}`))
 * ```
 */
export function direct<T = unknown>(
  endpoint: string,
  options?: Partial<DirectSourceOptions>,
): DirectAdapter<T>;
export function direct<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
  options?: Partial<DirectDestinationOptions>,
): DirectAdapter<T>;
export function direct<T = unknown>(
  endpoint: string | ((exchange: Exchange<T>) => string),
  options?: Partial<DirectAdapterOptions>,
): DirectAdapter<T> {
  return new DirectAdapter<T>(endpoint, options);
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
 * craft()
 *   .from(timer({ intervalMs: 5000 }))
 *   .to(periodicTask)
 *
 * // Run 10 times, once per second
 * craft()
 *   .from(timer({ intervalMs: 1000, repeatCount: 10 }))
 *   .to(batchTask)
 * ```
 */
export function timer(options?: TimerOptions): TimerAdapter {
  return new TimerAdapter(options);
}

/**
 * Create an HTTP client adapter for making requests.
 * Acts as processor, enricher, or destination depending on usage site.
 */
export function fetch<T = unknown, R = unknown>(
  options: FetchOptions<T>,
): FetchAdapter<T, R> {
  return new FetchAdapter<T, R>(options);
}
