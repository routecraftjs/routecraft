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
   * When true, runSteps will not emit generic step:started/step:completed
   * events for this step. The step is responsible for emitting its own
   * lifecycle events with the correct exchange identity.
   */
  skipStepEvents?: boolean;

  /**
   * Optional metadata populated by the adapter during execution.
   * Used for observability, metrics, and cost tracking.
   * Guidelines: small values only (IDs, names, counts, codes), no large bodies.
   */
  metadata?: Record<string, unknown>;

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

/**
 * Context lifecycle events.
 *
 * Emitted during context startup and shutdown:
 * - `context:starting` - Context is about to start (before routes start)
 * - `context:started` - Context has started (all routes started)
 * - `context:stopping` - Context is about to stop (before routes stop)
 * - `context:stopped` - Context has stopped (all routes stopped)
 */
export type ContextEventName =
  | "context:starting"
  | "context:started"
  | "context:stopping"
  | "context:stopped"
  | "context:error";

/**
 * Route lifecycle events (hierarchical naming with routeId).
 *
 * Emitted during route registration and lifecycle:
 * - `route:<routeId>:registered` - Route registered with context
 * - `route:<routeId>:starting` - Route is about to start
 * - `route:<routeId>:started` - Route has started and is ready to process exchanges
 * - `route:<routeId>:stopping` - Route is about to stop
 * - `route:<routeId>:stopped` - Route has stopped
 * - `route:<routeId>:error` - Unhandled error in route pipeline
 * - `route:<routeId>:error:caught` - Route error handler recovered
 */
export type RouteEventName =
  | `route:${string}:registered`
  | `route:${string}:starting`
  | `route:${string}:started`
  | `route:${string}:stopping`
  | `route:${string}:stopped`
  | `route:${string}:error`
  | `route:${string}:error:caught`
  | `route:${string}:step:${string}:error`
  | `route:${string}:step:${string}:error:caught`;

/**
 * Exchange lifecycle events (hierarchical naming with routeId).
 *
 * Emitted for each exchange (message) processed by a route:
 * - `route:<routeId>:exchange:started` - Exchange enters route pipeline
 * - `route:<routeId>:exchange:completed` - Exchange completed successfully
 * - `route:<routeId>:exchange:failed` - Exchange processing failed
 *
 * Use wildcards to subscribe to events:
 * - `route:*:exchange:started` - All exchange started events (any route)
 * - `route:payment:exchange:*` - All exchange events for 'payment' route
 *
 * @example
 * ```typescript
 * ctx.on('route:payment:exchange:started', ({ details }) => {
 *   console.log('Exchange started:', details.exchangeId);
 * });
 *
 * // Monitor all exchanges across all routes
 * ctx.on('route:*:exchange:*', ({ details }) => {
 *   console.log(`Route ${details.routeId}: ${details.exchangeId}`);
 * });
 * ```
 */
export type ExchangeEventName =
  | `route:${string}:exchange:started`
  | `route:${string}:exchange:completed`
  | `route:${string}:exchange:failed`
  | `route:${string}:exchange:dropped`
  | `route:${string}:exchange:restored`;

/**
 * Plugin lifecycle events.
 *
 * Auto-emitted events for plugin lifecycle:
 * - `plugin:<pluginId>:registered` - Plugin registered with context
 * - `plugin:<pluginId>:starting` - Plugin is about to start
 * - `plugin:<pluginId>:started` - Plugin has started
 * - `plugin:<pluginId>:stopping` - Plugin is about to stop
 * - `plugin:<pluginId>:stopped` - Plugin has stopped
 *
 * @example
 * ```typescript
 * ctx.on('plugin:*:started', ({ details }) => {
 *   console.log('Plugin started:', details.pluginId);
 * });
 * ```
 */
export type PluginEventName =
  | `plugin:${string}:registered`
  | `plugin:${string}:starting`
  | `plugin:${string}:started`
  | `plugin:${string}:stopping`
  | `plugin:${string}:stopped`
  | `plugin:${string}:${string}:${string}`
  | `plugin:${string}:${string}:${string}:${string}`;

/**
 * Step lifecycle events (hierarchical naming with routeId).
 *
 * Emitted for each processing step in a route's pipeline. Steps cover all
 * adapter operations (from, to, process, filter, transform, etc.). Operation
 * type and adapter details are in the event payload, not the event name.
 *
 * @example
 * ```typescript
 * ctx.on('route:api:step:completed', ({ details }) => {
 *   console.log('Step:', details.operation, details.adapter, 'in', details.duration, 'ms');
 * });
 * ```
 */
export type StepEventName =
  | `route:${string}:step:started`
  | `route:${string}:step:completed`;

/**
 * Special route-level events for batch, retry, and error handling.
 *
 * **Batch events:**
 * - `route:<routeId>:batch:started` - Route starts batching exchanges
 * - `route:<routeId>:batch:flushed` - Batch released for processing
 * - `route:<routeId>:batch:stopped` - Route stops batching
 *
 * **Retry events:**
 * - `route:<routeId>:retry:started` - Retry sequence started
 * - `route:<routeId>:retry:attempt` - Retry attempt (fires N times)
 * - `route:<routeId>:retry:stopped` - Retry sequence completed
 *
 * **Error handler events:**
 * - `route:<routeId>:error-handler:invoked` - Error handler called
 * - `route:<routeId>:error-handler:recovered` - Error handler succeeded
 * - `route:<routeId>:error-handler:failed` - Error handler also failed
 *
 * @example
 * ```typescript
 * ctx.on('route:*:batch:flushed', ({ details }) => {
 *   console.log('Batch flushed:', details.batchSize, 'exchanges');
 * });
 *
 * ctx.on('route:*:retry:attempt', ({ details }) => {
 *   console.log('Retry attempt', details.attemptNumber, 'of', details.maxAttempts);
 * });
 * ```
 */
export type SpecialEventName =
  | `route:${string}:batch:started`
  | `route:${string}:batch:flushed`
  | `route:${string}:batch:stopped`
  | `route:${string}:retry:started`
  | `route:${string}:retry:attempt`
  | `route:${string}:retry:stopped`
  | `route:${string}:error-handler:invoked`
  | `route:${string}:error-handler:recovered`
  | `route:${string}:error-handler:failed`;

/**
 * Authentication events.
 *
 * Emitted by auth-enabled adapters on every auth attempt.
 * `details.source` identifies the adapter that emitted the event (e.g. `"mcp"`).
 *
 * - `auth:success` - Token validated, principal resolved
 * - `auth:rejected` - Auth failed (missing header, bad scheme, invalid token)
 *
 * @example
 * ```typescript
 * ctx.on('auth:success', ({ details }) => {
 *   audit.log(details.source, details.subject, details.scheme);
 * });
 * ctx.on('auth:rejected', ({ details }) => {
 *   metrics.increment('auth.rejected', { source: details.source, reason: details.reason });
 * });
 * ```
 */
export type AuthEventName = "auth:success" | "auth:rejected";

/**
 * Union of all event names supported by the event system.
 *
 * Supports hierarchical event naming with wildcards:
 * - Exact: `route:payment:exchange:started`
 * - Single-level wildcard: `route:*:exchange:started`
 * - Multi-level wildcard: `route:payment:*`
 * - Global wildcard: `*`
 *
 * @see ContextEventName - Context lifecycle events
 * @see RouteEventName - Route lifecycle events
 * @see ExchangeEventName - Exchange lifecycle events
 * @see StepEventName - Step lifecycle events
 * @see PluginEventName - Plugin lifecycle events
 * @see SpecialEventName - Batch, retry, error-handler events
 * @see AuthEventName - Authentication events
 */
export type EventName =
  | ContextEventName
  | RouteEventName
  | ExchangeEventName
  | StepEventName
  | PluginEventName
  | SpecialEventName
  | AuthEventName;

// Static event details mapping (non-hierarchical events)
export type StaticEventDetails = {
  "context:starting": Record<string, never>;
  "context:started": Record<string, never>;
  "context:stopping": { reason?: unknown };
  "context:stopped": Record<string, never>;
  "context:error": {
    error: unknown;
    route?: Route;
    exchange?: Exchange<unknown>;
  };

  // Auth
  "auth:success": {
    subject: string;
    scheme: string;
    source: string;
  };
  "auth:rejected": {
    reason: string;
    scheme: string;
    source: string;
  };
};

// -- Category-level detail types for EventDetailsMapping --
// Organized by event category to keep nesting shallow.

/** Detail types for `route:<routeId>:<suffix>` events. */
type RouteEventDetails<S extends string> =
  // Exchange lifecycle
  S extends "exchange:started"
    ? { routeId: string; exchangeId: string; correlationId: string }
    : S extends "exchange:completed"
      ? {
          routeId: string;
          exchangeId: string;
          correlationId: string;
          duration: number;
          exchange?: {
            id: string;
            headers: Record<string, unknown>;
            body: unknown;
          };
        }
      : S extends "exchange:failed"
        ? {
            routeId: string;
            exchangeId: string;
            correlationId: string;
            duration: number;
            error: unknown;
            exchange?: {
              id: string;
              headers: Record<string, unknown>;
              body: unknown;
            };
          }
        : S extends "exchange:dropped"
          ? {
              routeId: string;
              exchangeId: string;
              correlationId: string;
              reason: string;
              exchange?: {
                id: string;
                headers: Record<string, unknown>;
                body: unknown;
              };
            }
          : S extends "exchange:restored"
            ? {
                routeId: string;
                exchangeId: string;
                correlationId: string;
                source: string;
              }
            : // Steps
              S extends "step:started"
              ? {
                  routeId: string;
                  exchangeId: string;
                  correlationId: string;
                  operation: OperationType;
                  adapter?: string;
                }
              : S extends "step:completed"
                ? {
                    routeId: string;
                    exchangeId: string;
                    correlationId: string;
                    operation: OperationType;
                    adapter?: string;
                    duration: number;
                    metadata?: Record<string, unknown>;
                  }
                : // Batch
                  S extends "batch:started"
                  ? { routeId: string; batchSize: number; batchId: string }
                  : S extends "batch:flushed"
                    ? {
                        routeId: string;
                        batchSize: number;
                        batchId: string;
                        waitTime: number;
                        reason: "size" | "time";
                      }
                    : S extends "batch:stopped"
                      ? { routeId: string; batchId: string }
                      : // Retry
                        S extends "retry:started"
                        ? {
                            routeId: string;
                            exchangeId: string;
                            correlationId: string;
                            maxAttempts: number;
                          }
                        : S extends "retry:attempt"
                          ? {
                              routeId: string;
                              exchangeId: string;
                              correlationId: string;
                              attemptNumber: number;
                              maxAttempts: number;
                              backoffMs: number;
                              lastError?: unknown;
                            }
                          : S extends "retry:stopped"
                            ? {
                                routeId: string;
                                exchangeId: string;
                                correlationId: string;
                                attemptNumber: number;
                                success: boolean;
                              }
                            : // Error handler
                              S extends "error-handler:invoked"
                              ? {
                                  routeId: string;
                                  exchangeId: string;
                                  correlationId: string;
                                  originalError: unknown;
                                  failedOperation: string;
                                }
                              : S extends "error-handler:recovered"
                                ? {
                                    routeId: string;
                                    exchangeId: string;
                                    correlationId: string;
                                    originalError: unknown;
                                    failedOperation: string;
                                    recoveryStrategy: string;
                                  }
                                : S extends "error-handler:failed"
                                  ? {
                                      routeId: string;
                                      exchangeId: string;
                                      correlationId: string;
                                      originalError: unknown;
                                      failedOperation: string;
                                      recoveryStrategy?: string;
                                    }
                                  : // Step errors (multi-segment suffix)
                                    S extends `step:${string}:error:caught`
                                    ? {
                                        error: unknown;
                                        route?: Route;
                                        exchange?: Exchange<unknown>;
                                        operation: string;
                                      }
                                    : S extends `step:${string}:error`
                                      ? {
                                          error: unknown;
                                          route?: Route;
                                          exchange?: Exchange<unknown>;
                                          operation: string;
                                        }
                                      : // Route errors
                                        S extends "error:caught"
                                        ? {
                                            error: unknown;
                                            route?: Route;
                                            exchange?: Exchange<unknown>;
                                          }
                                        : S extends "error"
                                          ? {
                                              error: unknown;
                                              route?: Route;
                                              exchange?: Exchange<unknown>;
                                            }
                                          : // Route lifecycle (must be last to avoid matching multi-segment suffixes)
                                            S extends
                                                | "registered"
                                                | "starting"
                                                | "started"
                                            ? { route: Route }
                                            : S extends "stopping"
                                              ? {
                                                  route: Route;
                                                  reason?: unknown;
                                                  exchange?: Exchange<unknown>;
                                                }
                                              : S extends "stopped"
                                                ? {
                                                    route: Route;
                                                    exchange?: Exchange<unknown>;
                                                  }
                                                : never;

/** Detail types for `plugin:<pluginId>:<suffix>` events. */
type PluginEventDetails<S extends string> = S extends
  | "registered"
  | "starting"
  | "started"
  | "stopping"
  | "stopped"
  ? { pluginId: string; pluginIndex: number }
  : Record<string, unknown>;

/**
 * Maps an event name to its detail payload type.
 *
 * Uses category extraction to keep nesting shallow:
 * 1. Static events (context, system) via lookup
 * 2. Route events via `RouteEventDetails`
 * 3. Plugin events via `PluginEventDetails`
 */
export type EventDetailsMapping<K extends EventName = EventName> =
  K extends keyof StaticEventDetails
    ? StaticEventDetails[K]
    : K extends `route:${string}:${infer Suffix}`
      ? RouteEventDetails<Suffix>
      : K extends `plugin:${string}:${infer Suffix}`
        ? PluginEventDetails<Suffix>
        : never;

export type EventPayload<K extends EventName> = {
  ts: string;
  contextId: string;
  details: EventDetailsMapping<K>;
  /** The exact event name that was emitted. Set by context.emit(). */
  _event: string;
};

export type EventHandler<K extends EventName> = (
  payload: EventPayload<K>,
) => void | Promise<void>;
