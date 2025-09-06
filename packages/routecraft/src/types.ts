import { type Exchange, type ExchangeHeaders } from "./exchange.ts";
import { type OperationType } from "./exchange.ts";
import { type CraftContext } from "./context.ts";
import { type RouteDefinition } from "./route.ts";
import { type Route } from "./route.ts";

// eslint-disable-next-line
export interface Adapter {}

export interface StepDefinition<T extends Adapter> {
  operation: OperationType;
  adapter: T;

  execute(
    exchange: Exchange,
    remainingSteps: StepDefinition<Adapter>[],
    queue: { exchange: Exchange; steps: StepDefinition<Adapter>[] }[],
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
  register(
    handler: (message: unknown, headers?: ExchangeHeaders) => Promise<Exchange>,
  ): void;
}

// ProcessingQueue is an internal queue API for route source→consumer flow
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
  routeStopping: { route: Route; reason?: unknown; exchange?: Exchange };
  routeStopped: { route: Route; exchange?: Exchange };

  // System
  error: { error: unknown; route?: Route; exchange?: Exchange };
};

export type EventPayload<K extends EventName> = {
  ts: string;
  context: CraftContext;
  details: EventDetailsMapping[K];
};

export type EventHandler<K extends EventName> = (
  payload: EventPayload<K>,
) => void | Promise<void>;
