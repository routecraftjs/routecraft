import type { Source, Subscription } from "../../../operations/from";
import type { EventName, EventPayload } from "../../../types";
import type { EventFilter } from "./types";

/**
 * Event source adapter that produces exchanges from framework events.
 * Subscribes to context events and emits them as exchanges.
 *
 * Events a route's own exchanges emit (`route:step:*`, `route:exchange:*`,
 * `route:operation:*`, and errors raised while one runs) are not delivered
 * back to it: every step emits step events, so the route would otherwise feed
 * on itself. Its own lifecycle events, such as `route:started`, are delivered.
 *
 * Two `event()` routes that each watch step or exchange events still feed
 * each other: every exchange one runs emits events the other consumes. Point
 * observability routes at the routes they observe, not at each other.
 *
 * ```typescript
 * // Every step of every other route, as it completes
 * craft()
 *   .id("step-metrics")
 *   .from(event("route:step:completed"))
 *   .to(log())
 *
 * // Failed exchanges of one route only
 * craft()
 *   .id("orders-failures")
 *   .from(event("route:exchange:failed"))
 *   .filter((ex) => ex.body.details.routeId === "orders")
 *   .to(http({ url: alertUrl }))
 * ```
 */
export class EventSourceAdapter implements Source<EventPayload<EventName>> {
  readonly adapterId = "routecraft.adapter.event";

  constructor(private filter: EventFilter) {}

  async subscribe(sub: Subscription<EventPayload<EventName>>): Promise<void> {
    const context = sub.context;
    const filters = Array.isArray(this.filter) ? this.filter : [this.filter];
    const unsubscribers: Array<() => void> = [];

    const ownRouteId = sub.meta.routeId;

    // Determine which events to subscribe to
    const eventNames = this.resolveEventNames(filters);

    context.logger.debug(
      { adapter: "event", filter: this.filter, eventNames },
      "Subscribing to events",
    );

    const deliver = async (
      eventName: string,
      payload: EventPayload<EventName>,
    ): Promise<void> => {
      if (!sub.signal.aborted) {
        if (isOwnExchangeEvent(payload, ownRouteId)) return;
        try {
          await sub.emit({ message: payload });
        } catch (err) {
          const metaMessage =
            typeof err === "object" &&
            err !== null &&
            "meta" in err &&
            typeof (err as { meta?: { message?: unknown } }).meta?.message ===
              "string"
              ? (err as { meta: { message: string } }).meta.message
              : undefined;
          const errorMessage =
            typeof err === "object" &&
            err !== null &&
            "message" in err &&
            typeof (err as { message?: unknown }).message === "string"
              ? (err as { message: string }).message
              : undefined;

          context.logger.warn(
            { adapter: "event", event: eventName, err },
            metaMessage ?? errorMessage ?? "Event handler failed",
          );
        }
      }
    };

    // Exact names subscribe directly; patterns (legacy wildcard syntax)
    // attach ONE catch-all subscription and match the emitted name per
    // event. The matcher cost is scoped to routes that use event() with
    // patterns; the context's event bus itself stays pattern-free.
    const exactNames = eventNames.filter((n) => !n.includes("*"));
    const patterns = eventNames.filter((n) => n.includes("*"));

    for (const eventName of exactNames) {
      unsubscribers.push(
        context.on(eventName as EventName, (payload) =>
          deliver(eventName, payload as EventPayload<EventName>),
        ),
      );
    }
    if (patterns.length > 0) {
      unsubscribers.push(
        context.on("*", (payload) => {
          const emitted = (payload as { _event: string })._event;
          if (patterns.some((p) => matchesEventPattern(emitted, p))) {
            return deliver(emitted, payload as EventPayload<EventName>);
          }
          return undefined;
        }),
      );
    }

    // Cleanup on abort
    sub.signal.addEventListener("abort", () => {
      context.logger.debug({ adapter: "event" }, "Unsubscribing from events");
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    });

    sub.ready();

    // Keep the subscription alive until aborted
    return new Promise<void>((resolve) => {
      // Check if already aborted
      if (sub.signal.aborted) {
        resolve();
        return;
      }

      // Add listener with { once: true } to prevent leaks
      sub.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }

  /**
   * Resolve event names from filters. Exact names subscribe directly;
   * names containing `*` are treated as patterns matched against emitted
   * event names via the adapter's local matcher.
   */
  private resolveEventNames(filters: string[]): string[] {
    // Deduplicate filters
    const resolved = new Set<string>();

    for (const filter of filters) {
      resolved.add(filter);
    }

    return Array.from(resolved);
  }
}

/**
 * Whether an event was emitted while one of this route's own exchanges ran.
 *
 * Every step emits `route:step:*` and every exchange `route:exchange:*`, so
 * an `event()` route delivered its own events would start an exchange per
 * event it processes, forever, and starve the event loop. The route's own
 * lifecycle events (`route:started` and the like) carry no exchange and are
 * still delivered.
 */
function isOwnExchangeEvent(
  payload: EventPayload<EventName>,
  ownRouteId: string,
): boolean {
  const details = payload.details as {
    routeId?: unknown;
    exchangeId?: unknown;
    exchange?: unknown;
  };
  return (
    details.routeId === ownRouteId &&
    (details.exchangeId !== undefined || details.exchange !== undefined)
  );
}

/**
 * Match an emitted event name against a colon-segmented pattern.
 * `*` matches one segment; `**` matches zero or more segments; a bare
 * `"*"` pattern matches everything. Local to the event source adapter:
 * the framework's event names are a fixed set and the bus has no pattern
 * matching, but this adapter keeps the pattern UX for observability
 * routes (cold path, per-subscription).
 */
export function matchesEventPattern(event: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "**") return true;
  if (!pattern.includes("*")) return event === pattern;

  const eventSegments = event.split(":");
  const patternSegments = pattern.split(":");

  let e = 0;
  let p = 0;
  while (p < patternSegments.length) {
    const seg = patternSegments[p];
    if (seg === "**") {
      if (p === patternSegments.length - 1) return true;
      const rest = patternSegments.slice(p + 1).join(":");
      for (let i = e; i <= eventSegments.length; i++) {
        if (matchesEventPattern(eventSegments.slice(i).join(":"), rest)) {
          return true;
        }
      }
      return false;
    } else if (seg === "*") {
      if (e >= eventSegments.length) return false;
      e++;
      p++;
    } else {
      if (e >= eventSegments.length || eventSegments[e] !== seg) return false;
      e++;
      p++;
    }
  }
  return e === eventSegments.length;
}
