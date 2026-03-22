import { NoopDestinationAdapter } from "./destination.ts";

/**
 * Create a no-operation adapter that does nothing.
 *
 * This can be useful for testing or as a placeholder.
 *
 * @template T The type of data this adapter processes
 * @returns A NoopDestinationAdapter instance
 */
export function noop<T = unknown>(): NoopDestinationAdapter<T> {
  return new NoopDestinationAdapter<T>();
}
