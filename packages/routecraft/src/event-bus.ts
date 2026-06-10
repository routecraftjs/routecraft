import {
  type EventHandler,
  type EventName,
  type EventPayload,
} from "./types.ts";

/**
 * Minimal logging surface the bus needs for handler-error reporting.
 * Matches the pino child logger used by `CraftContext`.
 */
type EventBusLogger = {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
};

/**
 * In-process event bus backing `CraftContext.on/once/emit`.
 *
 * Owns handler registration (exact and wildcard patterns), payload
 * construction, dispatch, and handler-error containment. Extracted from
 * `CraftContext` so eventing is a single-responsibility unit; the context
 * exposes the same public API via 1-line delegation.
 *
 * Not exported from the package index: the public subscription surface is
 * `CraftContext.on/once`. Tests may import this module directly.
 *
 * @internal
 */
export class EventBus {
  /** Registered event handlers */
  private readonly handlers: Map<EventName, Set<EventHandler<EventName>>> =
    new Map();

  /** Wildcard event handlers (for pattern matching like "route:*" or "*") */
  private readonly wildcardHandlers: Map<string, Set<EventHandler<EventName>>> =
    new Map();

  constructor(
    private readonly contextId: string,
    private readonly logger: EventBusLogger,
  ) {}

  /**
   * Subscribe to an event name or wildcard pattern.
   *
   * @param event - Event name or wildcard pattern (e.g. `route:started`, `route:*`, `route:**`)
   * @param handler - Callback receiving `{ ts, contextId, details }`
   * @returns Unsubscribe function (call to remove the handler)
   */
  on<K extends EventName>(event: K, handler: EventHandler<K>): () => void;
  on(event: string, handler: EventHandler<EventName>): () => void;
  on(event: EventName | string, handler: EventHandler<EventName>): () => void {
    // Check if this is a wildcard pattern
    const isWildcard = typeof event === "string" && event.includes("*");

    if (isWildcard) {
      const set = this.wildcardHandlers.get(event) ?? new Set();
      set.add(handler as unknown as EventHandler<EventName>);
      this.wildcardHandlers.set(event, set);
      return () => {
        set.delete(handler as unknown as EventHandler<EventName>);
      };
    } else {
      const set = this.handlers.get(event as EventName) ?? new Set();
      set.add(handler as unknown as EventHandler<EventName>);
      this.handlers.set(event as EventName, set);
      return () => {
        set.delete(handler as unknown as EventHandler<EventName>);
      };
    }
  }

  /**
   * Subscribe to an event for a single occurrence. The handler is
   * automatically removed after the first time the event is emitted.
   *
   * Supports the same wildcard patterns as `on()`.
   *
   * @param event - Event name or wildcard pattern
   * @param handler - Callback receiving `{ ts, contextId, details }`
   * @returns Unsubscribe function (call to remove the handler before it fires)
   */
  once<K extends EventName>(event: K, handler: EventHandler<K>): () => void;
  once(event: string, handler: EventHandler<EventName>): () => void;
  once(
    event: EventName | string,
    handler: EventHandler<EventName>,
  ): () => void {
    const wrappedHandler: EventHandler<EventName> = (payload) => {
      unsubscribe();
      return handler(payload);
    };
    const unsubscribe = this.on(event, wrappedHandler);
    return unsubscribe;
  }

  /**
   * Emit an event to registered handlers.
   *
   * @param event - Event name
   * @param details - Event-specific payload (merged into `EventPayload.details`)
   */
  emit<K extends EventName>(
    event: K,
    details: EventPayload<K>["details"],
  ): void {
    const payload: EventPayload<K> = {
      ts: new Date().toISOString(),
      contextId: this.contextId,
      details,
    } as EventPayload<K>;

    payload._event = event;

    // Collect all matching handlers (exact match + wildcards)
    const matchingHandlers: EventHandler<EventName>[] = [];

    // 1. Exact match handlers
    const exactSet = this.handlers.get(event);
    if (exactSet && exactSet.size > 0) {
      matchingHandlers.push(...Array.from(exactSet));
    }

    // 2. Wildcard handlers
    for (const [pattern, handlerSet] of this.wildcardHandlers) {
      if (this.matchesPattern(event, pattern)) {
        matchingHandlers.push(...Array.from(handlerSet));
      }
    }

    if (matchingHandlers.length === 0) return;

    // Execute all matching handlers
    for (const handler of matchingHandlers) {
      try {
        const result = (handler as unknown as EventHandler<K>)(payload);
        // Handle async handlers properly to catch promise rejections
        if (result && typeof result.then === "function") {
          void result.catch((err: unknown) => {
            // Log async handler errors at error level for error events, warn for others
            const logLevel = event === "context:error" ? "error" : "warn";
            this.logger[logLevel](
              { event, err },
              "Async event handler rejected. Handler should not throw; errors are emitted as context 'error' event.",
            );
            if (event !== "context:error") {
              this.emit("context:error", { error: err });
            }
          });
        }
      } catch (err) {
        // Swallow synchronous handler errors but log them and emit system error
        // Log error events at error level, others at warn
        const logLevel = event === "context:error" ? "error" : "warn";
        this.logger[logLevel](
          { event, err },
          "Event handler threw. Handler should not throw; errors are emitted as context 'error' event.",
        );
        if (event !== "context:error") {
          this.emit("context:error", { error: err });
        }
      }
    }
  }

  /**
   * Check if an event name matches a wildcard pattern.
   * Supports:
   * - "*" matches all events
   * - "route:*" matches all route events (route:started, route:stopped, etc.)
   * - "exchange:*" matches all exchange events
   * - "route:myroute:*" matches all events for a specific route
   * - "route:*:step:*" matches hierarchical patterns at any level
   *
   * @param event - Event name to match
   * @param pattern - Wildcard pattern
   * @returns True if the event matches the pattern
   */
  private matchesPattern(event: string, pattern: string): boolean {
    // Special case: "*" matches everything
    if (pattern === "*") return true;

    // Exact match (no wildcards)
    if (!pattern.includes("*")) return event === pattern;

    // Check for ** globstar wildcard (multi-level matching)
    if (pattern.includes("**")) {
      return this.matchesGlobstarPattern(event, pattern);
    }

    // Tokenize both event and pattern on ":"
    const eventSegments = event.split(":");
    const patternSegments = pattern.split(":");

    // Must have same number of segments
    if (eventSegments.length !== patternSegments.length) return false;

    // Match each segment (exact match or wildcard)
    for (let i = 0; i < patternSegments.length; i++) {
      const patternSeg = patternSegments[i];
      const eventSeg = eventSegments[i];

      // Wildcard matches any segment
      if (patternSeg === "*") continue;

      // Exact match required
      if (patternSeg !== eventSeg) return false;
    }

    return true;
  }

  /**
   * Match event against pattern with ** globstar wildcards.
   * ** matches zero or more segments at any level.
   *
   * Examples:
   * - "route:**" matches "route:started", "route:payment:exchange:started", etc.
   * - "route:*:step:**" matches "route:api:step:started", etc.
   */
  private matchesGlobstarPattern(event: string, pattern: string): boolean {
    const eventSegments = event.split(":");
    const patternSegments = pattern.split(":");

    let eventIdx = 0;
    let patternIdx = 0;

    while (patternIdx < patternSegments.length) {
      const patternSeg = patternSegments[patternIdx];

      if (patternSeg === "**") {
        // ** is the last segment - matches everything remaining
        if (patternIdx === patternSegments.length - 1) {
          return true;
        }

        // Try to match remaining pattern at each possible position in event
        const remainingPattern = patternSegments
          .slice(patternIdx + 1)
          .join(":");

        // Try matching from current position onwards
        for (let i = eventIdx; i <= eventSegments.length; i++) {
          const remainingEvent = eventSegments.slice(i).join(":");
          if (this.matchesPattern(remainingEvent, remainingPattern)) {
            return true;
          }
        }

        return false;
      } else if (patternSeg === "*") {
        // Single-level wildcard - must have a segment to match
        if (eventIdx >= eventSegments.length) return false;
        eventIdx++;
        patternIdx++;
      } else {
        // Exact match required
        if (
          eventIdx >= eventSegments.length ||
          eventSegments[eventIdx] !== patternSeg
        ) {
          return false;
        }
        eventIdx++;
        patternIdx++;
      }
    }

    // All pattern segments matched - event must be fully consumed too
    return eventIdx === eventSegments.length;
  }
}
