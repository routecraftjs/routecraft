import { rcError } from "./error.ts";
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
 * Event names are a fixed, finite set (see `EventDetailsMap`); identity
 * (route id, plugin id, step label) lives in the payload. Subscription is
 * by exact name, plus the single catch-all `"*"` for telemetry-style taps
 * that observe every event. There is no pattern matching: emit is one Map
 * lookup plus the catch-all set, so the per-step hot path stays flat no
 * matter how many subscriptions exist.
 *
 * Not exported from the package index: the public subscription surface is
 * `CraftContext.on/once`. Tests may import this module directly.
 *
 * @internal
 */
export class EventBus {
  /** Exact-name event handlers */
  private readonly handlers: Map<EventName, Set<EventHandler<EventName>>> =
    new Map();

  /** Catch-all handlers subscribed via `"*"` (receive every event) */
  private readonly catchAllHandlers: Set<EventHandler<EventName>> = new Set();

  constructor(
    private readonly contextId: string,
    private readonly logger: EventBusLogger,
  ) {}

  /**
   * Subscribe to an exact event name, or `"*"` for every event.
   *
   * Legacy wildcard patterns (`route:*`, `route:**`, ...) are rejected
   * loudly: identity moved into event payloads, so per-route filtering is
   * `ctx.on("route:exchange:failed", forRoute("orders", handler))`.
   *
   * @param event - Exact event name or `"*"`
   * @param handler - Callback receiving `{ ts, contextId, details }`
   * @returns Unsubscribe function (call to remove the handler)
   */
  on<K extends EventName>(event: K, handler: EventHandler<K>): () => void;
  on(event: "*", handler: EventHandler<EventName>): () => void;
  on(event: EventName | "*", handler: EventHandler<EventName>): () => void {
    if (event === "*") {
      this.catchAllHandlers.add(handler);
      return () => {
        this.catchAllHandlers.delete(handler);
      };
    }
    if (typeof event === "string" && event.includes("*")) {
      throw rcError("RC2001", undefined, {
        message:
          `Event pattern "${event}" is not supported: event names are a fixed set and identity lives in the payload. ` +
          `Subscribe to the exact name (e.g. "route:exchange:failed") and filter with forRoute(routeId, handler), ` +
          `or use "*" to observe every event.`,
      });
    }
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as unknown as EventHandler<EventName>);
    this.handlers.set(event, set);
    return () => {
      set.delete(handler as unknown as EventHandler<EventName>);
    };
  }

  /**
   * Subscribe to an event for a single occurrence. The handler is
   * automatically removed after the first time the event is emitted.
   *
   * Accepts the same names as `on()` (exact names or `"*"`).
   *
   * @param event - Exact event name or `"*"`
   * @param handler - Callback receiving `{ ts, contextId, details }`
   * @returns Unsubscribe function (call to remove the handler before it fires)
   */
  once<K extends EventName>(event: K, handler: EventHandler<K>): () => void;
  once(event: "*", handler: EventHandler<EventName>): () => void;
  once(event: EventName | "*", handler: EventHandler<EventName>): () => void {
    const wrappedHandler: EventHandler<EventName> = (payload) => {
      unsubscribe();
      return handler(payload);
    };
    const unsubscribe = this.on(event as EventName, wrappedHandler);
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
    const exactSet = this.handlers.get(event);
    const exactCount = exactSet ? exactSet.size : 0;
    if (exactCount === 0 && this.catchAllHandlers.size === 0) return;

    const payload: EventPayload<K> = {
      ts: new Date().toISOString(),
      contextId: this.contextId,
      details,
    } as EventPayload<K>;

    payload._event = event;

    // Snapshot so handlers that unsubscribe (once) or subscribe during
    // dispatch do not affect this emit.
    const matchingHandlers: EventHandler<EventName>[] = [];
    if (exactSet && exactCount > 0) {
      matchingHandlers.push(...Array.from(exactSet));
    }
    if (this.catchAllHandlers.size > 0) {
      matchingHandlers.push(...Array.from(this.catchAllHandlers));
    }

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
}
