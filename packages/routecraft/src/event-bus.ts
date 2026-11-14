import type { Logger } from "./logger.ts";
import { rcError } from "./error.ts";
import type {
  EventDetailsMap,
  EventHandler,
  EventName,
  EventPayload,
  ExchangeSnapshot,
  ExchangeSnapshotEnvelope,
  SubscribeOptions,
} from "./types.ts";
import { isThenable } from "./shared/thenable.ts";
import { CREDENTIAL_HEADERS } from "./shared/credential-headers.ts";
import { snapshotOf } from "./event-snapshot.ts";

/** The exchange an event names, as the bus copies it for a snapshot. */
type EventExchange = Parameters<typeof snapshotOf>[0];

/** What one subscription asked for, and on whose behalf it was made. */
interface Subscription {
  readonly snapshots: boolean;
  readonly reader: string;
}

/** The handlers of one event name, each with the subscription it was made with. */
type Subscribers = Map<EventHandler<EventName>, Subscription>;

/** The reader a subscription made outside a plugin is counted under. */
export const APPLICATION_READER = "application";

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
 * The `_snapshot` envelope of an event reaches only a subscription made with
 * `{ snapshots: true }`. The exchange copy inside it is built here, at most
 * once per emit and only when such a subscription reads it, from the live
 * exchange the emitter hands over beside the details; the live exchange
 * itself reaches no handler.
 *
 * Not exported from the package index: the public subscription surface is
 * `CraftContext.on/once`. Tests may import this module directly.
 *
 * @internal
 */
export class EventBus {
  /** Exact-name event handlers */
  private readonly handlers: Map<EventName, Subscribers> = new Map();

  /** Catch-all handlers subscribed via `"*"` (receive every event) */
  private readonly catchAllHandlers: Subscribers = new Map();

  /** Header names left out of every snapshot, lowercased. */
  private secretHeaders: ReadonlySet<string> = new Set(CREDENTIAL_HEADERS);

  constructor(
    private readonly contextId: string,
    private readonly logger: Pick<Logger, "warn" | "error">,
  ) {}

  /**
   * Add header names to leave out of every snapshot, beside the built-in
   * credential headers. Names are matched case-insensitively.
   */
  addSecretHeaders(names: Iterable<string>): void {
    const next = new Set(this.secretHeaders);
    for (const name of names) next.add(name.toLowerCase());
    this.secretHeaders = next;
  }

  /**
   * Subscribe to an exact event name, or `"*"` for every event.
   *
   * Legacy wildcard patterns (`route:*`, `route:**`, ...) are rejected
   * loudly: identity moved into event payloads, so per-route filtering is
   * `ctx.on("route:exchange:failed", forRoute("orders", handler))`.
   *
   * @param event - Exact event name or `"*"`
   * @param handler - Callback receiving `{ ts, contextId, details }`
   * @param options - `snapshots: true` to receive the `_snapshot` envelope.
   *   It holds for this subscription alone: the same handler subscribed to
   *   another event without it receives no envelope there
   * @param reader - Who the subscription is counted under in
   *   `snapshotReaders()`: a plugin id, or the application
   * @returns Unsubscribe function (call to remove the handler)
   */
  on<K extends EventName>(
    event: K,
    handler: EventHandler<K>,
    options?: SubscribeOptions,
    reader?: string,
  ): () => void;
  on(
    event: "*",
    handler: EventHandler<EventName>,
    options?: SubscribeOptions,
    reader?: string,
  ): () => void;
  on(
    event: EventName | "*",
    handler: EventHandler<EventName>,
    options?: SubscribeOptions,
    reader: string = APPLICATION_READER,
  ): () => void {
    const subscription: Subscription = {
      snapshots: options?.snapshots === true,
      reader,
    };
    if (event === "*") {
      this.catchAllHandlers.set(handler, subscription);
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
    const subscribers: Subscribers = this.handlers.get(event) ?? new Map();
    subscribers.set(handler, subscription);
    this.handlers.set(event, subscribers);
    return () => {
      subscribers.delete(handler);
    };
  }

  /** Who holds a live subscription made with `{ snapshots: true }`. */
  snapshotReaders(): string[] {
    const readers = new Set<string>();
    for (const subscribers of [
      this.catchAllHandlers,
      ...this.handlers.values(),
    ]) {
      for (const { snapshots, reader } of subscribers.values()) {
        if (snapshots) readers.add(reader);
      }
    }
    return [...readers];
  }

  /**
   * Subscribe to an event for a single occurrence. The handler is
   * automatically removed after the first time the event is emitted.
   *
   * Accepts the same names as `on()` (exact names or `"*"`).
   *
   * @param event - Exact event name or `"*"`
   * @param handler - Callback receiving `{ ts, contextId, details }`
   * @param options - `snapshots: true` to receive the `_snapshot` envelope
   * @param reader - Who the subscription is counted under
   * @returns Unsubscribe function (call to remove the handler before it fires)
   */
  once<K extends EventName>(
    event: K,
    handler: EventHandler<K>,
    options?: SubscribeOptions,
    reader?: string,
  ): () => void;
  once(
    event: "*",
    handler: EventHandler<EventName>,
    options?: SubscribeOptions,
    reader?: string,
  ): () => void;
  once(
    event: EventName | "*",
    handler: EventHandler<EventName>,
    options?: SubscribeOptions,
    reader?: string,
  ): () => void {
    const wrappedHandler: EventHandler<EventName> = (payload) => {
      unsubscribe();
      return handler(payload);
    };
    const unsubscribe = this.on(
      event as EventName,
      wrappedHandler,
      options,
      reader,
    );
    return unsubscribe;
  }

  /**
   * Emit an event to registered handlers.
   *
   * @param event - Event name
   * @param details - Event-specific payload (merged into `EventPayload.details`)
   * @param exchange - The live exchange the event names, copied into
   *   `_snapshot.exchange` for the subscriptions that asked for snapshots
   */
  emit<K extends EventName>(
    event: K,
    details: EventDetailsMap[K],
    exchange?: EventExchange,
  ): void {
    const exactSet = this.handlers.get(event);
    const exactCount = exactSet ? exactSet.size : 0;
    if (exactCount === 0 && this.catchAllHandlers.size === 0) return;

    const ts = new Date().toISOString();
    const payloadOf = (given: EventDetailsMap[K]): EventPayload<K> => ({
      ts,
      contextId: this.contextId,
      details: given,
      _event: event,
    });
    let plain: EventPayload<K> | undefined;
    let snapshotted: EventPayload<K> | undefined;
    let asyncReader = false;
    const payloadFor = (subscription: Subscription): EventPayload<K> =>
      subscription.snapshots
        ? (snapshotted ??= payloadOf(this.withSnapshot(details, exchange)))
        : (plain ??= payloadOf(withoutSnapshot(details)));

    // Copied so handlers that unsubscribe (once) or subscribe during
    // dispatch do not affect this emit.
    const matching: [EventHandler<EventName>, Subscription][] = [
      ...(exactSet ?? []),
      ...this.catchAllHandlers,
    ];

    for (const [handler, subscription] of matching) {
      try {
        const result = (handler as unknown as EventHandler<K>)(
          payloadFor(subscription),
        );
        // A thenable carries no `catch`, and reaching for one unwrapped
        // throws from inside this `try`, misreporting the handler as
        // having thrown when it returned normally.
        if (isThenable(result)) {
          asyncReader ||= subscription.snapshots;
          void Promise.resolve(result).catch((err: unknown) => {
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
    // A handler still running reads the copy after the exchange has moved on.
    if (asyncReader) {
      void (snapshotted?.details as ExchangeSnapshotEnvelope | undefined)
        ?._snapshot?.exchange;
    }
  }

  private withSnapshot<D>(details: D, exchange: EventExchange | undefined): D {
    if (exchange === undefined) return details;
    const envelope = { ...(details as { _snapshot?: object })._snapshot };
    const secret = this.secretHeaders;
    let copy: ExchangeSnapshot | undefined;
    // Most opted-in handlers read the copy for a few exchanges only, and the
    // clone is the cost of the whole emit.
    Object.defineProperty(envelope, "exchange", {
      enumerable: true,
      get: () => (copy ??= snapshotOf(exchange, secret)),
    });
    return { ...details, _snapshot: envelope };
  }
}

function withoutSnapshot<D>(details: D): D {
  if (typeof details !== "object" || details === null) return details;
  if (!("_snapshot" in details)) return details;
  const rest = { ...details } as D & { _snapshot?: unknown };
  delete rest._snapshot;
  return rest;
}
