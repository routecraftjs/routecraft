import type { Source } from "../../../operations/from";
import type { EventPayload, EventName } from "../../../types";
import { EventSourceAdapter } from "./source";
import type { EventFilter } from "./types";

/**
 * Creates a source that produces exchanges from framework events.
 * Use as the first step in a route with `.from(event(...))`.
 *
 * @template T - Event payload type
 * @param filter - Event name(s) or wildcard pattern to listen for
 * @returns A Source usable with `.from(event(filter))`
 *
 * @example
 * ```typescript
 * // Single event
 * .from(event('route:started'))
 *
 * // Multiple events
 * .from(event(['route:started', 'route:stopped']))
 *
 * // Wildcard: All route events
 * .from(event('route:*'))
 *
 * // Wildcard: All events
 * .from(event('*'))
 * ```
 */
export function event(filter: EventFilter): Source<EventPayload<EventName>> {
  return new EventSourceAdapter(filter);
}

// Re-export types for public API
export type { EventFilter, EventSourceOptions } from "./types";
export { EventSourceAdapter } from "./source";
