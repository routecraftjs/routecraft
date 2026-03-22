import type { Destination } from "../../operations/to.ts";
import { NoopDestinationAdapter } from "./destination.ts";

/**
 * Create a no-operation adapter that does nothing.
 *
 * This can be useful for testing or as a placeholder.
 *
 * @template T The type of data this adapter processes
 * @returns A Destination that discards all messages
 */
export function noop<T = unknown>(): Destination<T> {
  return new NoopDestinationAdapter<T>();
}
