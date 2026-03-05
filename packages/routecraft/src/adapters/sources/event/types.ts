import type { EventName } from "../../../types";

/**
 * Event filter options for the event source adapter.
 * Supports single event names, arrays, and wildcard patterns.
 */
export type EventFilter = EventName | EventName[] | string | string[];

/**
 * Options for the event source adapter.
 */
export interface EventSourceOptions {
  /**
   * Event name(s) to listen for.
   * Supports:
   * - Single event name: 'route:started'
   * - Array of event names: ['route:started', 'route:stopped']
   * - Wildcard patterns: 'route:*', 'exchange:*', 'route:myroute:*', '*'
   */
  filter: EventFilter;
}
