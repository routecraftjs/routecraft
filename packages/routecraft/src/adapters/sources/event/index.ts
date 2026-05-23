import type { Source } from "../../../operations/from";
import type { EventPayload, EventName } from "../../../types";
import { EventSourceAdapter } from "./source";
import type { EventFilter } from "./types";

/**
 * Creates a source that produces exchanges from framework events.
 * Use as the first step in a route with `.from(event(...))`.
 *
 * **Wildcard Patterns:**
 *
 * - `*` (single-level wildcard): Matches exactly one segment
 *   - Pattern and event must have the same number of colon-separated segments
 *   - Example: `route:*` matches `route:started` (2 segments), but NOT `route:payment:exchange:started` (4 segments)
 *
 * - `**` (globstar wildcard): Matches zero or more segments at any level
 *   - Example: `route:**` matches `route:started`, `route:payment:exchange:started`, etc.
 *   - Example: `route:*:operation:**` matches all operations with any adapter depth
 *
 * **Static vs Dynamic Events:**
 *
 * For static event subscriptions (context:started, route:started, etc.), wildcards
 * expand at initialization time against known event names. For hierarchical events
 * (route:X:exchange:Y, route:X:operation:Y:Z), use explicit patterns or ** globstar
 * to match runtime route IDs.
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
 * // Single-level wildcard: All static route events (2 segments)
 * .from(event('route:*'))
 *
 * // Globstar: All route events at any depth
 * .from(event('route:**'))
 *
 * // Match all route exchange events (4 segments)
 * .from(event('route:*:exchange:*'))
 *
 * // Match all operations with any adapter depth
 * .from(event('route:*:operation:**'))
 *
 * // Match all events
 * .from(event('*'))
 * ```
 */
export function event(filter: EventFilter): Source<EventPayload<EventName>> {
  return new EventSourceAdapter(filter);
}

// Re-export types for public API
export type { EventFilter, EventSourceOptions } from "./types";
export { EventSourceAdapter } from "./source";
