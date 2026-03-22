import type { Source } from "../../operations/from";
import { SimpleSourceAdapter } from "./source";

/**
 * Creates a source that produces one or more exchanges.
 * Use as the first step in a route with `.from(simple(...))`.
 *
 * When the producer returns (or is) an **array**, each element becomes a
 * separate exchange processed independently through the pipeline. This is
 * useful for seeding multiple messages from a single source. To pass an
 * array as the body of a single exchange, wrap it:
 * `simple({ items: [1, 2, 3] })` or use a transform after a string source.
 *
 * **Note:** If you need to emit a function itself as a value (not call it as a producer),
 * use `simple.value(myFunction)` instead of `simple(myFunction)`.
 *
 * @template T - Body type produced
 * @param producer - Static value, or function that returns T | Promise<T>
 * @returns A Source usable with `.from(simple(producer))`
 *
 * @example
 * ```typescript
 * // Single exchange with string body
 * .from(simple('hello'))
 *
 * // Two separate exchanges (one per array element)
 * .from(simple([1, 2]))
 *
 * // Single exchange with array body (wrap in object)
 * .from(simple({ items: [1, 2] }))
 *
 * // Async producer
 * .from(simple(() => fetch('/api/data').then(r => r.json())))
 *
 * // Emit a function as a value
 * .from(simple.value(myCallback))
 * ```
 */
export function simple<T = unknown>(
  producer: (() => T | Promise<T>) | T,
): Source<T> {
  return new SimpleSourceAdapter<T>(
    typeof producer === "function"
      ? (producer as () => T | Promise<T>)
      : () => producer,
  );
}

/**
 * Creates a source that emits a static value without checking if it's a function.
 * Use this when you need to emit a function itself as a value.
 *
 * @template T - The value type to emit
 * @param value - The value to emit (including functions)
 * @returns A Source that emits the value as-is
 *
 * @example
 * ```typescript
 * const myCallback = () => console.log('hello');
 * .from(simple.value(myCallback)) // Emits the function, doesn't call it
 * ```
 */
simple.value = function <T>(value: T): Source<T> {
  return new SimpleSourceAdapter<T>(() => value);
};

// Re-export adapter class for public API
export { SimpleSourceAdapter } from "./source";
