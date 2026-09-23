import type { Source } from "../../../operations/from";
import type { EventPayload, EventName } from "../../../types";
import { EventSourceAdapter } from "./source";
import type { EventFilter } from "./types";
import { tagAdapter, factoryArgs } from "../../shared/factory-tag";

/**
 * Creates a source that produces exchanges from framework events.
 * Use as the first step in a route with `.from(event(...))`.
 *
 * Event names are a fixed set; the route id and the exchange live in the
 * payload's `details`, so scope to one route by filtering on
 * `details.routeId`. Patterns match the emitted name:
 *
 * - `*` matches exactly one colon-separated segment: `route:exchange:*`
 *   matches `route:exchange:failed` but not `route:started`.
 * - `**` matches zero or more segments: `route:**` matches every route event.
 * - `*` on its own matches every event.
 *
 * Events the route's own exchanges emit are not delivered back to it; see
 * {@link EventSourceAdapter}.
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
 * // Every exchange event: started, completed, failed, dropped, ...
 * .from(event('route:exchange:*'))
 *
 * // Every operation event, at any depth
 * .from(event('route:operation:**'))
 *
 * // Every route event
 * .from(event('route:**'))
 *
 * // Match all events
 * .from(event('*'))
 * ```
 */
export function event(filter: EventFilter): Source<EventPayload<EventName>> {
  return tagAdapter(new EventSourceAdapter(filter), event, factoryArgs(filter));
}

// Re-export types for public API
export type { EventFilter, EventSourceOptions } from "./types";
export { EventSourceAdapter } from "./source";
