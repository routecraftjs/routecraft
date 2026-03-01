import { type Exchange, type ExchangeHeaders } from "./exchange.ts";
import { type OperationType } from "./exchange.ts";
import { type CraftContext } from "./context.ts";
import { type RouteDefinition } from "./route.ts";
import { type Route } from "./route.ts";

/**
 * Base interface for all adapters (sources, destinations, transformers, filters, etc.).
 * Adapters can expose an optional `adapterId` string for logging (e.g. "routecraft.adapter.log").
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Marker interface for adapter union
export interface Adapter {}

/**
 * Returns a short label for logging which adapter is used.
 * Uses adapterId's last segment (e.g. "routecraft.adapter.llm" → "llm"), constructor name, or "inline" for plain objects.
 *
 * @param adapter - Adapter instance (or undefined)
 * @returns Label string or undefined
 */
export function getAdapterLabel(
  adapter: Adapter | undefined,
): string | undefined {
  if (!adapter) return undefined;
  const a = adapter as { adapterId?: string };
  if (a.adapterId) return a.adapterId.split(".").pop();
  const name = (adapter as { constructor?: { name?: string } }).constructor
    ?.name;
  return name === "Object" ? "inline" : name;
}

export interface Step<T extends Adapter> {
  operation: OperationType;
  adapter: T;

  /**
   * Execute this step. The exchange is typed as Exchange at runtime (body is unknown);
   * the builder chain preserves body types for the next step, but custom steps receive
   * an untyped exchange. Narrow or assert body type if needed.
   */
  execute(
    exchange: Exchange,
    remainingSteps: Step<Adapter>[],
    queue: { exchange: Exchange; steps: Step<Adapter>[] }[],
  ): Promise<void>;
}

// MessageChannel lives with channel adapter now

export type ConsumerType<T extends Consumer, O = unknown> = new (
  context: CraftContext,
  definition: RouteDefinition,
  channel: unknown,
  options: O,
) => T;

export type Message = {
  message: unknown;
  headers?: ExchangeHeaders;
};

export interface Consumer<O = unknown> {
  context: CraftContext;
  channel: unknown; // will be narrowed by specific consumer types
  definition: RouteDefinition;
  options: O;
  /**
   * Register the route handler. At runtime, message and the returned exchange's body
   * are untyped (unknown). The builder chain is typed; narrow or assert in the handler
   * if you need to access body fields.
   */
  register(
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<Exchange>,
  ): void;
}

/**
 * Internal queue API for route source→consumer flow. Sources enqueue messages; the consumer handler is set by the route and receives messages. Used by DefaultRoute.
 *
 * @template T - Message type (typically Message with message + headers)
 */
export interface ProcessingQueue<T = unknown> {
  enqueue(message: T): Promise<Exchange>;
  setHandler(handler: (message: T) => Promise<Exchange>): Promise<void> | void;
  clear(): Promise<void> | void;
}

// Events API

export type ContextEventName =
  | "contextStarting"
  | "contextStarted"
  | "contextStopping"
  | "contextStopped";

export type RouteEventName =
  | "routeRegistered"
  | "routeStarting"
  | "routeStarted"
  | "routeStopping"
  | "routeStopped";

export type SystemEventName = "error";

export type EventName = ContextEventName | RouteEventName | SystemEventName;

export type EventDetailsMapping = {
  // Context
  contextStarting: Record<string, never>;
  contextStarted: Record<string, never>;
  contextStopping: { reason?: unknown };
  contextStopped: Record<string, never>;

  // Route
  routeRegistered: { route: Route };
  routeStarting: { route: Route };
  routeStarted: { route: Route };
  routeStopping: {
    route: Route;
    reason?: unknown;
    exchange?: Exchange<unknown>;
  };
  routeStopped: { route: Route; exchange?: Exchange<unknown> };

  // System
  error: { error: unknown; route?: Route; exchange?: Exchange<unknown> };
};

export type EventPayload<K extends EventName> = {
  ts: string;
  context: CraftContext;
  details: EventDetailsMapping[K];
};

export type EventHandler<K extends EventName> = (
  payload: EventPayload<K>,
) => void | Promise<void>;
