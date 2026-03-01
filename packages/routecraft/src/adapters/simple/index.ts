import type { Source } from "../../operations/from";
import { SimpleSourceAdapter } from "./source";

/**
 * Creates a source that produces a single value (or one value per call from a function).
 * Use as the first step in a route with `.from(simple(...))`.
 *
 * @template T - Body type produced
 * @param producer - Static value, or function that returns T | Promise<T>
 * @returns A Source usable with `.from(simple(producer))`
 *
 * @example
 * ```typescript
 * .from(simple('hello'))
 * .from(simple(() => fetch('/api/data').then(r => r.json())))
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

// Re-export adapter class for public API
export { SimpleSourceAdapter } from "./source";
