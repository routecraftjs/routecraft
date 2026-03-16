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
  | "context:stopped";

/**
 * Route lifecycle events.
 *
 * Emitted during route registration and lifecycle:
 * - `route:registered` - Route registered with context (during build or registerRoutes)
 * - `route:starting` - Route is about to start
 * - `route:started` - Route has started and is ready to process exchanges
 * - `route:stopping` - Route is about to stop
 * - `route:stopped` - Route has stopped
 */
export type RouteEventName =
  | "route:registered"
  | "route:starting"
  | "route:started"
  | "route:stopping"
  | "route:stopped";

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
 * Operation lifecycle events (Wave 3 - granular adapter tracking).
 *
 * Provides fine-grained tracking of adapter operations with hierarchical naming:
 *
 * **Adapter operations (5 levels):**
 * - `route:<routeId>:operation:from:<adapterId>:started` - Source adapter operation started
 * - `route:<routeId>:operation:from:<adapterId>:stopped` - Source adapter operation stopped
 * - `route:<routeId>:operation:to:<adapterId>:started` - Destination adapter operation started
 * - `route:<routeId>:operation:to:<adapterId>:stopped` - Destination adapter operation stopped
 *
 * **Processing operations (4 levels):**
 * - `route:<routeId>:operation:<processingType>:started` - Processing operation started
 * - `route:<routeId>:operation:<processingType>:stopped` - Processing operation stopped
 *
 * Where:
 * - `<adapterId>` = mcp | llm | http | kafka | direct | etc.
 * - `<processingType>` = process | filter | transform | enrich | etc.
 *
 * @example
 * ```typescript
 * // Monitor all MCP adapter calls across all routes
 * ctx.on('route:*:operation:from:mcp:*', ({ details }) => {
 *   console.log('MCP call:', details.metadata.toolName);
 * });
 *
 * // Track LLM costs
 * ctx.on('route:*:operation:to:llm:stopped', ({ details }) => {
 *   const { inputTokens, outputTokens } = details.metadata;
 *   console.log('Tokens used:', inputTokens + outputTokens);
 * });
 *
 * // Monitor HTTP destination calls
 * ctx.on('route:payment:operation:to:http:stopped', ({ details }) => {
 *   console.log('HTTP call:', details.metadata.statusCode);
 * });
 * ```
 */
export type OperationEventName =
  | `route:${string}:operation:from:${string}:started`
  | `route:${string}:operation:from:${string}:stopped`
  | `route:${string}:operation:to:${string}:started`
  | `route:${string}:operation:to:${string}:stopped`
  | `route:${string}:operation:${string}:started`
  | `route:${string}:operation:${string}:stopped`;

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
 * Plugins can also emit custom events using pattern: `plugin:<pluginId>:<custom>:<event>`
 *
 * @example
 * ```typescript
 * // Monitor when plugins start
 * ctx.on('plugin:*:started', ({ details }) => {
 *   console.log('Plugin started:', details.pluginId);
 * });
 *
 * // Listen to custom plugin events
 * ctx.on('plugin:myPlugin:metrics:collected', ({ details }) => {
 *   console.log('Metrics:', details);
 * });
 * ```
 */
export type PluginEventName =
  | `plugin:${string}:registered`
  | `plugin:${string}:starting`
  | `plugin:${string}:started`
  | `plugin:${string}:stopping`
  | `plugin:${string}:stopped`;

/**
 * Step lifecycle events (hierarchical naming with routeId).
 *
 * Emitted for each processing step in a route's pipeline:
 * - `route:<routeId>:step:started` - Processing step started
 * - `route:<routeId>:step:completed` - Processing step completed
 *
 * Steps include: from (source adapter), process, filter, transform, to (destination adapter)
 *
 * Use wildcards to subscribe to events:
 * - `route:*:step:started` - All step started events (any route)
 * - `route:api:step:*` - All step events for 'api' route
 *
 * @example
 * ```typescript
 * ctx.on('route:api:step:completed', ({ details }) => {
 *   console.log('Step completed:', details.operation, 'in', details.duration, 'ms');
 * });
 * ```
 *
 */
export type StepEventName =
  | `route:${string}:step:started`
  | `route:${string}:step:completed`;

/**
 * Special operation events for batch, split, aggregate, retry, and error handling.
 *
 * **Batch operations (route-level):**
 * - `route:<routeId>:operation:batch:started` - Route starts batching exchanges
 * - `route:<routeId>:operation:batch:flushed` - Batch released for processing
 * - `route:<routeId>:operation:batch:stopped` - Route stops batching
 *
 * **Split/Aggregate:** Use standard `step:started`/`step:completed` events with
 * operation-specific data in the `metadata` field (e.g. `childCount`, `inputCount`).
 *
 * **Retry operations (exchange-level):**
 * - `route:<routeId>:operation:retry:started` - Retry sequence started
 * - `route:<routeId>:operation:retry:attempt` - Retry attempt (fires N times)
 * - `route:<routeId>:operation:retry:stopped` - Retry sequence completed
 *
 * **Error handling operations (exchange-level):**
 * - `route:<routeId>:operation:error:invoked` - Error handler called
 * - `route:<routeId>:operation:error:recovered` - Error handler succeeded
 * - `route:<routeId>:operation:error:failed` - Error handler also failed
 *
 * @example
 * ```typescript
 * // Track batch flush behavior
 * ctx.on('route:*:operation:batch:flushed', ({ details }) => {
 *   console.log('Batch flushed:', details.batchSize, 'exchanges');
 * });
 *
 * // Monitor retry attempts
 * ctx.on('route:*:operation:retry:attempt', ({ details }) => {
 *   console.log('Retry attempt', details.attemptNumber, 'of', details.maxAttempts);
 * });
 * ```
 */
export type SpecialOperationEventName =
  | `route:${string}:operation:batch:started`
  | `route:${string}:operation:batch:flushed`
  | `route:${string}:operation:batch:stopped`
  | `route:${string}:operation:retry:started`
  | `route:${string}:operation:retry:attempt`
  | `route:${string}:operation:retry:stopped`
  | `route:${string}:operation:error:invoked`
  | `route:${string}:operation:error:recovered`
  | `route:${string}:operation:error:failed`;

/**
 * System-wide error event.
 *
 * Emitted when errors occur during context startup, route processing, or step execution.
 * Always subscribe to this event to handle errors gracefully.
 *
 * @example
 * ```typescript
 * ctx.on('error', ({ details }) => {
 *   console.error('Error:', details.error);
 *   if (details.route) console.error('Route:', details.route.definition.id);
 *   if (details.exchange) console.error('Exchange:', details.exchange.id);
 * });
 * ```
 */
export type SystemEventName = "error";

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
 * @see StepEventName - Step lifecycle events (deprecated, use OperationEventName)
 * @see OperationEventName - Operation lifecycle events (Wave 3)
 * @see PluginEventName - Plugin lifecycle events
 * @see SpecialOperationEventName - Batch, split, aggregate, retry, error events
 * @see SystemEventName - System error events
 */
export type EventName =
  | ContextEventName
  | RouteEventName
  | ExchangeEventName
  | StepEventName
  | OperationEventName
  | PluginEventName
  | SpecialOperationEventName
  | SystemEventName;

// Static event details mapping (non-hierarchical events)
export type StaticEventDetails = {
  // Context
  "context:starting": Record<string, never>;
  "context:started": Record<string, never>;
  "context:stopping": { reason?: unknown };
  "context:stopped": Record<string, never>;

  // Route
  "route:registered": { route: Route };
  "route:starting": { route: Route };
  "route:started": { route: Route };
  "route:stopping": {
    route: Route;
    reason?: unknown;
    exchange?: Exchange<unknown>;
  };
  "route:stopped": { route: Route; exchange?: Exchange<unknown> };

  // System
  error: { error: unknown; route?: Route; exchange?: Exchange<unknown> };
};

// Conditional type mapping for hierarchical event names
// IMPORTANT: More specific patterns must come BEFORE general patterns!
// TypeScript evaluates conditional types in order, so specific patterns like
// 'route:${string}:operation:batch:started' must be checked before
// 'route:${string}:operation:${string}:started' to ensure correct type matching.
export type EventDetailsMapping<K extends EventName = EventName> =
  K extends keyof StaticEventDetails
    ? StaticEventDetails[K]
    : K extends `route:${string}:exchange:started`
      ? {
          routeId: string;
          exchangeId: string;
          correlationId: string;
        }
      : K extends `route:${string}:exchange:completed`
        ? {
            routeId: string;
            exchangeId: string;
            correlationId: string;
            duration: number;
          }
        : K extends `route:${string}:exchange:failed`
          ? {
              routeId: string;
              exchangeId: string;
              correlationId: string;
              duration: number;
              error: unknown;
            }
          : K extends `route:${string}:exchange:dropped`
            ? {
                routeId: string;
                exchangeId: string;
                correlationId: string;
                reason: string;
              }
            : K extends `route:${string}:exchange:restored`
              ? {
                  routeId: string;
                  exchangeId: string;
                  correlationId: string;
                  source: string;
                }
              : K extends `route:${string}:operation:batch:started`
                ? {
                    routeId: string;
                    batchSize: number;
                    batchId: string;
                  }
                : K extends `route:${string}:operation:batch:flushed`
                  ? {
                      routeId: string;
                      batchSize: number;
                      batchId: string;
                      waitTime: number;
                      reason: "size" | "time";
                    }
                  : K extends `route:${string}:operation:batch:stopped`
                    ? {
                        routeId: string;
                        batchId: string;
                      }
                    : K extends `route:${string}:operation:retry:started`
                      ? {
                          routeId: string;
                          exchangeId: string;
                          correlationId: string;
                          maxAttempts: number;
                        }
                      : K extends `route:${string}:operation:retry:attempt`
                        ? {
                            routeId: string;
                            exchangeId: string;
                            correlationId: string;
                            attemptNumber: number;
                            maxAttempts: number;
                            backoffMs: number;
                            lastError?: unknown;
                          }
                        : K extends `route:${string}:operation:retry:stopped`
                          ? {
                              routeId: string;
                              exchangeId: string;
                              correlationId: string;
                              attemptNumber: number;
                              success: boolean;
                            }
                          : K extends `route:${string}:operation:error:invoked`
                            ? {
                                routeId: string;
                                exchangeId: string;
                                correlationId: string;
                                originalError: unknown;
                                failedOperation: string;
                              }
                            : K extends `route:${string}:operation:error:recovered`
                              ? {
                                  routeId: string;
                                  exchangeId: string;
                                  correlationId: string;
                                  originalError: unknown;
                                  failedOperation: string;
                                  recoveryStrategy: string;
                                }
                              : K extends `route:${string}:operation:error:failed`
                                ? {
                                    routeId: string;
                                    exchangeId: string;
                                    correlationId: string;
                                    originalError: unknown;
                                    failedOperation: string;
                                    recoveryStrategy?: string;
                                  }
                                : K extends `route:${string}:operation:from:${string}:started`
                                  ? {
                                      routeId: string;
                                      exchangeId: string;
                                      correlationId: string;
                                      operation: OperationType;
                                      adapterId: string;
                                      metadata?: Record<string, unknown>;
                                    }
                                  : K extends `route:${string}:operation:from:${string}:stopped`
                                    ? {
                                        routeId: string;
                                        exchangeId: string;
                                        correlationId: string;
                                        operation: OperationType;
                                        adapterId: string;
                                        duration: number;
                                        metadata?: Record<string, unknown>;
                                      }
                                    : K extends `route:${string}:operation:to:${string}:started`
                                      ? {
                                          routeId: string;
                                          exchangeId: string;
                                          correlationId: string;
                                          operation: OperationType;
                                          adapterId: string;
                                          metadata?: Record<string, unknown>;
                                        }
                                      : K extends `route:${string}:operation:to:${string}:stopped`
                                        ? {
                                            routeId: string;
                                            exchangeId: string;
                                            correlationId: string;
                                            operation: OperationType;
                                            adapterId: string;
                                            duration: number;
                                            metadata?: Record<string, unknown>;
                                          }
                                        : K extends `route:${string}:operation:${string}:started`
                                          ? {
                                              routeId: string;
                                              exchangeId: string;
                                              correlationId: string;
                                              operation: OperationType;
                                              metadata?: Record<
                                                string,
                                                unknown
                                              >;
                                            }
                                          : K extends `route:${string}:operation:${string}:stopped`
                                            ? {
                                                routeId: string;
                                                exchangeId: string;
                                                correlationId: string;
                                                operation: OperationType;
                                                duration: number;
                                                metadata?: Record<
                                                  string,
                                                  unknown
                                                >;
                                              }
                                            : K extends `route:${string}:step:started`
                                              ? {
                                                  routeId: string;
                                                  exchangeId: string;
                                                  correlationId: string;
                                                  operation: OperationType;
                                                  adapter?: string;
                                                }
                                              : K extends `route:${string}:step:completed`
                                                ? {
                                                    routeId: string;
                                                    exchangeId: string;
                                                    correlationId: string;
                                                    operation: OperationType;
                                                    adapter?: string;
                                                    duration: number;
                                                    metadata?: Record<
                                                      string,
                                                      unknown
                                                    >;
                                                  }
                                                : K extends `plugin:${string}:registered`
                                                  ? {
                                                      pluginId: string;
                                                      pluginIndex: number;
                                                    }
                                                  : K extends `plugin:${string}:starting`
                                                    ? {
                                                        pluginId: string;
                                                        pluginIndex: number;
                                                      }
                                                    : K extends `plugin:${string}:started`
                                                      ? {
                                                          pluginId: string;
                                                          pluginIndex: number;
                                                        }
                                                      : K extends `plugin:${string}:stopping`
                                                        ? {
                                                            pluginId: string;
                                                            pluginIndex: number;
                                                          }
                                                        : K extends `plugin:${string}:stopped`
                                                          ? {
                                                              pluginId: string;
                                                              pluginIndex: number;
                                                            }
                                                          : never;

export type EventPayload<K extends EventName> = {
  ts: string;
  contextId: string;
  details: EventDetailsMapping<K>;
};

export type EventHandler<K extends EventName> = (
  payload: EventPayload<K>,
) => void | Promise<void>;
