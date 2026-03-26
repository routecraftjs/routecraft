import { randomUUID } from "node:crypto";
import { BRAND, setBrand } from "./brand.ts";
import { DefaultRoute, type Route, type RouteDefinition } from "./route.ts";
import { rcError, RC } from "./error.ts";
import { isRoutecraftError } from "./brand.ts";
import { logger, childBindings } from "./logger.ts";
import { type DirectConfig } from "./adapters/direct/types.ts";
import { type HttpConfig } from "./adapters/http/types.ts";
import { type MailContextConfig } from "./adapters/mail/types.ts";
import { MailClientManager } from "./adapters/mail/client-manager.ts";
import { MAIL_CLIENT_MANAGER } from "./adapters/mail/shared.ts";
import { type TelemetryOptions } from "./telemetry/types.ts";
import { telemetry } from "./telemetry/index.ts";

import {
  type EventHandler,
  type EventName,
  type EventPayload,
} from "./types.ts";

/**
 * Base store registry that can be extended by adapters
 *
 * @example
 * ```typescript
 * // Extend the store registry with channel adapter types
 * declare module "@routecraft/routecraft" {
 *   interface StoreRegistry {
 *     "routecraft.adapter.channel.store": Map<string, import("./adapters/channel.ts").MessageChannel>;
 *     "routecraft.adapter.channel.config": Partial<ChannelAdapterOptions>;
 *   }
 * }
 * ```
 */
export interface StoreRegistry {
  [key: `${string}.${string}.${string}`]: unknown;
}

/**
 * Options with merged configuration support.
 * This type is used for adapters that support both direct options and
 * options that can be merged with context configuration.
 */
export type MergedOptions<T> = {
  /** Direct options for configuration */
  options: Partial<T>;

  /**
   * Function to merge options with context configuration
   * @param context The CraftContext instance
   * @returns Merged options
   */
  mergedOptions(context: CraftContext): T;
};

/**
 * A plugin configures the context at startup and can register cleanup when the
 * context stops. apply(ctx) runs before routes are registered (initPlugins()).
 * teardown(ctx) runs when the context stops, after routes have drained.
 * Plugins that only need init can omit teardown; use ctx.registerTeardown()
 * from apply() for one-off cleanup callbacks.
 */
export interface CraftPlugin {
  apply(ctx: CraftContext): void | Promise<void>;
  /** Called when the context stops, after routes have drained. Optional. */
  teardown?(ctx: CraftContext): void | Promise<void>;
}

/**
 * Configuration options for creating a CraftContext.
 */
export type CraftConfig = {
  /** Initial values for the context store */
  store?: Map<keyof StoreRegistry, StoreRegistry[keyof StoreRegistry]>;
  /** Event handlers to register on context creation */
  on?: Partial<
    Record<EventName, EventHandler<EventName> | EventHandler<EventName>[]>
  >;
  /** One-time event handlers to register on context creation (fire once, then auto-unsubscribe) */
  once?: Partial<
    Record<EventName, EventHandler<EventName> | EventHandler<EventName>[]>
  >;
  /** Plugins to run before routes are registered (call initPlugins() then registerRoutes) */
  plugins?: CraftPlugin[];
  /** Reserved: direct adapter / channel config (no-op today) */
  direct?: DirectConfig;
  /** Reserved: HTTP server config for inbound (no-op today) */
  http?: HttpConfig;
  /** Mail adapter configuration with named accounts */
  mail?: MailContextConfig;
  /** Telemetry plugin configuration (SQLite, OpenTelemetry) */
  telemetry?: TelemetryOptions;
};

/**
 * The main context for running and managing routes.
 *
 * CraftContext is the central runtime environment that:
 * - Manages the lifecycle of routes
 * - Provides a storage system for adapters
 * - Handles startup and shutdown of the application
 *
 * @example
 * ```typescript
 * // Create a context with routes and event handlers
 * const context = new CraftContext({
 *   on: {
 *     'context:starting': async () => {
 *       console.log('Starting application');
 *     },
 *     'context:stopping': async () => {
 *       console.log('Shutting down application');
 *     }
 *   }
 * });
 *
 * // Register routes
 * context.registerRoutes(myRoute1, myRoute2);
 *
 * // Start processing routes
 * await context.start();
 *
 * // Later, stop all routes
 * await context.stop();
 * ```
 */
export class CraftContext {
  /** Unique identifier for this context instance */
  public readonly contextId: string = randomUUID();

  /** Routes registered with this context */
  private routes: Route[] = [];

  /** Abort controllers for each route */
  private controllers: Map<string, AbortController> = new Map();

  /** Storage for adapter configuration and state */
  private store = new Map<
    keyof StoreRegistry,
    StoreRegistry[keyof StoreRegistry]
  >();

  /** Logger for this context (pino child logger) */
  public readonly logger: ReturnType<typeof logger.child>;

  /** Registered event handlers */
  private readonly handlers: Map<EventName, Set<EventHandler<EventName>>> =
    new Map();

  /** Wildcard event handlers (for pattern matching like "route:*" or "*") */
  private readonly wildcardHandlers: Map<string, Set<EventHandler<EventName>>> =
    new Map();

  /** Plugins from config, run by initPlugins() before routes are registered */
  private readonly plugins: CraftPlugin[] = [];

  /** Teardown callbacks registered by plugins; run during stop() before context:stopped */
  private readonly teardownCallbacks: Array<() => void | Promise<void>> = [];

  /** Cached shutdown promise so concurrent stop() callers all await the same teardown */
  private shutdownPromise: Promise<void> | null = null;

  /**
   * Create a new CraftContext instance.
   *
   * @param config Optional configuration for the context
   */
  constructor(config?: CraftConfig) {
    setBrand(this, BRAND.CraftContext);
    this.logger = logger.child(childBindings(this));
    if (config) {
      // Initialize store from config
      if (config.store) {
        for (const [key, value] of config.store.entries()) {
          this.store.set(key, value);
        }
      }

      // Register event handlers from config
      if (config.on) {
        for (const [event, handler] of Object.entries(config.on)) {
          if (Array.isArray(handler)) {
            handler.forEach((h) => this.on(event as EventName, h));
          } else if (handler) {
            this.on(event as EventName, handler);
          }
        }
      }

      // Register one-time event handlers from config
      if (config.once) {
        for (const [event, handler] of Object.entries(config.once)) {
          if (Array.isArray(handler)) {
            handler.forEach((h) => this.once(event as EventName, h));
          } else if (handler) {
            this.once(event as EventName, handler);
          }
        }
      }
      // Set up mail client manager if mail config is present
      if (config.mail) {
        const manager = new MailClientManager(config.mail);
        this.store.set(MAIL_CLIENT_MANAGER as keyof StoreRegistry, manager);
        this.teardownCallbacks.push(() => manager.drain());
      }

      // Convert telemetry config into a plugin
      if (config.telemetry) {
        this.plugins.push(telemetry(config.telemetry));
      }

      if (config.plugins?.length) {
        this.plugins.push(...config.plugins);
      }
    }
  }

  /**
   * Generate a plugin identifier from the plugin's constructor name or index.
   * @param plugin The plugin instance
   * @param index The plugin's index in the plugins array
   * @returns A string identifier for the plugin
   */
  private getPluginId(plugin: CraftPlugin, index: number): string {
    const constructorName =
      plugin.constructor?.name !== "Object" ? plugin.constructor?.name : null;
    return constructorName ?? `plugin-${index}`;
  }

  /**
   * Run plugins from config. Call this before registerRoutes() so plugins can
   * set up state or dynamically add routes.
   *
   * Fails fast: on first plugin error, logs, emits `error`, and rethrows.
   *
   * @throws Rethrows if any plugin's `apply(ctx)` throws
   */
  async initPlugins(): Promise<void> {
    for (const [pluginIndex, plugin] of this.plugins.entries()) {
      try {
        if (
          !plugin ||
          typeof plugin !== "object" ||
          typeof (plugin as CraftPlugin).apply !== "function"
        ) {
          const err = rcError("RC9901", undefined, {
            message: `Invalid plugin at index ${pluginIndex}: expected object with apply(ctx)`,
          });
          this.logger.error(
            { pluginIndex, err },
            "Invalid plugin: expected object with apply(ctx) method.",
          );
          this.emit("context:error", { error: err });
          throw err;
        }

        // Generate plugin ID from constructor name or index
        const pluginId = this.getPluginId(plugin as CraftPlugin, pluginIndex);

        // Emit registered event
        this.emit(`plugin:${pluginId}:registered` as EventName, {
          pluginId,
          pluginIndex,
        });

        // Emit starting event
        this.emit(`plugin:${pluginId}:starting` as EventName, {
          pluginId,
          pluginIndex,
        });

        await (plugin as CraftPlugin).apply(this);

        // Emit started event
        this.emit(`plugin:${pluginId}:started` as EventName, {
          pluginId,
          pluginIndex,
        });
      } catch (err) {
        this.logger.error(
          { pluginIndex, err },
          "Plugin threw during initPlugins. Check stack and plugin implementation.",
        );
        this.emit("context:error", { error: err });
        throw err;
      }
    }
  }

  /**
   * Register a teardown callback to run when the context stops. Plugins use this
   * to release resources (e.g. caches, native handles) after routes have drained.
   * Callbacks run in registration order before `context:stopped` is emitted.
   *
   * @param fn - Callback (sync or async) to run during stop()
   */
  registerTeardown(fn: () => void | Promise<void>): void {
    this.teardownCallbacks.push(fn);
  }

  /**
   * Subscribe to lifecycle and system events.
   *
   * **Wildcard Patterns:**
   *
   * - `*` (single-level wildcard): Matches exactly one segment
   *   - Pattern and event must have the same number of colon-separated segments
   *   - Example: `route:*` matches `route:started` (2 segments), but NOT `route:payment:exchange:started` (4 segments)
   *
   * - `**` (globstar wildcard): Matches zero or more segments at any level
   *   - Example: `route:**` matches `route:started`, `route:payment:exchange:started`, etc.
   *   - Example: `route:*:operation:**` matches all operations with any adapter depth
   *
   * @param event - Event name or wildcard pattern (e.g. `route:started`, `route:*`, `route:**`)
   * @param handler - Callback receiving `{ ts, contextId, details }`
   * @returns Unsubscribe function (call to remove the handler)
   *
   * @example
   * ```typescript
   * // Subscribe to specific event
   * const unsubscribe = ctx.on('route:started', ({ details }) => {
   *   console.log('Route started:', details.route.definition.id);
   * });
   *
   * // Subscribe to all static route events (2 segments)
   * ctx.on('route:*', ({ details }) => {
   *   console.log('Route event:', details);
   * });
   *
   * // Subscribe to all route events at any depth (globstar)
   * ctx.on('route:**', ({ details }) => {
   *   console.log('Route event at any depth:', details);
   * });
   *
   * // Subscribe to all exchange events (4 segments)
   * ctx.on('route:*:exchange:*', ({ details }) => {
   *   console.log('Exchange event:', details);
   * });
   *
   * // later: unsubscribe();
   * ```
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
   * Subscribe to an event for a single occurrence. The handler is automatically
   * removed after the first time the event is emitted.
   *
   * Supports the same wildcard patterns as `on()`.
   *
   * @param event - Event name or wildcard pattern
   * @param handler - Callback receiving `{ ts, contextId, details }`
   * @returns Unsubscribe function (call to remove the handler before it fires)
   *
   * @example
   * ```typescript
   * // Wait for context to start
   * ctx.once('context:started', () => {
   *   console.log('Context started!');
   * });
   *
   * // Wait for any route to start
   * ctx.once('route:*', ({ details }) => {
   *   console.log('First route started:', details);
   * });
   * ```
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
   * @internal Public for use by routes/adapters; prefer subscribing via on()
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

  // onStartup/onShutdown removed in favor of event listeners

  /**
   * Register routes with this context.
   *
   * @param definitions Route definitions to register
   * @throws {RoutecraftError} If there are duplicate route IDs or invalid route definitions
   *
   * @example
   * ```typescript
   * // Register a single route
   * context.registerRoutes(myRoute);
   *
   * // Register multiple routes
   * context.registerRoutes(route1, route2, route3);
   * ```
   */
  registerRoutes(...definitions: RouteDefinition[]): void {
    // 1) Gather all IDs from the new route definitions
    const allIDs = definitions.map((def) => def.id);

    // 2) Check for duplicates within the new route definitions
    const hasInternalDuplicates = allIDs.some(
      (id, idx) => allIDs.indexOf(id) !== idx,
    );

    // 3) Check for duplicates against existing routes
    const conflictWithExistingRoutes = definitions.some((def) =>
      this.routes.some((r) => r.definition.id === def.id),
    );

    // 4) If either case has duplicates, throw the error
    if (hasInternalDuplicates || conflictWithExistingRoutes) {
      // Identify any one duplicate ID
      const duplicateId =
        allIDs.find((id, idx) => allIDs.indexOf(id) !== idx) ??
        definitions.find((def) =>
          this.routes.some((r) => r.definition.id === def.id),
        )?.id ??
        "unknown";

      throw rcError("RC1002", undefined, {
        message: `${RC["RC1002"].message}: ${duplicateId}`,
      });
    }

    // 5) Register each definition now that there's no duplication
    for (const definition of definitions) {
      if (!definition.source || !definition.source.subscribe) {
        throw rcError("RC1001", undefined, {
          message: `${RC["RC1001"].message}: ${definition.id}`,
        });
      }

      // Binder injection removed

      const controller = new AbortController();
      this.controllers.set(definition.id, controller);
      const route = new DefaultRoute(this, definition, controller);
      this.routes.push(route);
      this.emit(`route:${definition.id}:registered` as EventName, { route });
    }
  }

  /**
   * Get all routes registered with this context.
   *
   * @returns Array of routes
   */
  getRoutes(): Route[] {
    return this.routes;
  }

  /**
   * Get a value from the context store.
   *
   * @template K Store key type
   * @param key The store key to retrieve
   * @returns The stored value or undefined if not found
   *
   * @example
   * ```typescript
   * // Get channel store
   * const channelStore = context.getStore('routecraft.adapter.channel.store');
   * ```
   */
  getStore<K extends keyof StoreRegistry>(
    key: K,
  ): StoreRegistry[K] | undefined {
    const value = this.store.get(key);
    return value as StoreRegistry[K] | undefined;
  }

  /**
   * Set a value in the context store.
   *
   * @template K Store key type
   * @param key The store key
   * @param value The value to store
   *
   * @example
   * ```typescript
   * // Set channel store
   * context.setStore('routecraft.adapter.channel.store', new Map());
   * ```
   */
  setStore<K extends keyof StoreRegistry>(
    key: K,
    value: StoreRegistry[K],
  ): void {
    this.store.set(key, value);
  }

  /**
   * Find a route by its ID.
   *
   * @param id The route ID to find
   * @returns The matching route or undefined if not found
   */
  getRouteById(id: string): Route | undefined {
    return this.routes.find((route) => route.definition.id === id);
  }

  /**
   * Start all routes registered with this context.
   *
   * Emits `context:starting` and `context:started`, then starts all routes in parallel.
   * If all routes complete (e.g. finite sources), the context automatically stops.
   * If any route fails to start, the error is logged, emitted as `error`, and rethrown.
   *
   * **Context Lifecycle Events:**
   * - `context:starting` - Context initialization begins
   * - `context:started` - Context initialized (routes may not be started yet)
   * - `context:stopping` - Context shutdown begins
   * - `context:stopped` - Context shutdown complete
   *
   * **Note:** `context:started` fires after context initialization but BEFORE
   * individual routes start. To track route readiness, subscribe to
   * `route:started` or `route:stopping` events instead.
   * To filter by specific route, inspect details.route.definition.id in the handler.
   *
   * @returns A promise that resolves when all routes have started (or when context stops)
   * @throws If any route fails to start
   *
   * @example
   * ```typescript
   * try {
   *   await context.start();
   *   console.log('All routes started successfully');
   * } catch (error) {
   *   console.error('Failed to start routes:', error);
   * }
   * ```
   */
  async start(): Promise<void> {
    this.shutdownPromise = null;
    this.logger.info(
      { routeCount: this.routes.length },
      "Starting Routecraft context",
    );
    this.emit("context:starting", {});

    this.logger.debug({}, "Starting all routes");
    this.emit("context:started", {});
    return Promise.allSettled(
      this.routes.map(async (route) => {
        try {
          this.logger.info({ route: route.definition.id }, "Starting route");
          this.emit(`route:${route.definition.id}:starting` as EventName, {
            route,
          });
          await route.start();
          // Only log if the route completed on its own (not via context.stop())
          if (!this.shutdownPromise) {
            this.logger.info({ route: route.definition.id }, "Route completed");
          }
          return { routeId: route.definition.id, success: true as const };
        } catch (error) {
          const msg = isRoutecraftError(error)
            ? (error as { meta: { message: string } }).meta.message
            : error instanceof Error
              ? error.message
              : "Route failed to start";
          this.logger.fatal({ route: route.definition.id, err: error }, msg);
          this.emit("context:error", { error, route });
          // Abort just this failing route
          const controller = this.controllers.get(route.definition.id);
          controller?.abort();
          throw error;
        }
      }),
    )
      .then((results) => {
        // Skip if shutdown was already triggered (e.g. via signal handler)
        if (this.shutdownPromise) return this.shutdownPromise;

        // Check if all routes completed successfully
        const allFulfilled = results.every((r) => r.status === "fulfilled");
        if (allFulfilled) {
          this.logger.debug({}, "All routes have completed. Stopping context.");
          return this.stop();
        } else {
          this.logger.info(
            {},
            "Some routes ended or failed; context remains active. Call context.stop() or let other indefinite routes continue.",
          );
          // Do not stop automatically; let other routes run.
          return;
        }
      })
      .catch((error) => {
        const msg = isRoutecraftError(error)
          ? (error as { meta: { message: string } }).meta.message
          : error instanceof Error
            ? error.message
            : "Context start failed";
        this.logger.fatal({ err: error }, msg);
        this.emit("context:error", { error });
        throw error;
      });
  }

  /**
   * Wait for all in-flight route handlers (and their background tasks) to complete.
   * Does not stop sources; use stop() for full shutdown.
   *
   * @returns A promise that resolves when all routes have drained
   */
  async drain(): Promise<void> {
    this.logger.debug(
      { routeCount: this.routes.length },
      "Draining context: waiting for all route handlers and tasks",
    );
    await Promise.all(this.routes.map((r) => r.drain()));
    this.logger.debug({}, "Context drained");
  }

  /**
   * Stop all routes and shut down the context.
   *
   * This will:
   * 1. Abort all route controllers (stops sources)
   * 2. Drain all routes (wait for in-flight handlers and their background tasks)
   *
   * @returns A promise that resolves when all shutdown operations complete
   *
   * @example
   * ```typescript
   * // Handle shutdown signals
   * process.on('SIGINT', async () => {
   *   console.log('Shutting down...');
   *   await context.stop();
   *   process.exit(0);
   * });
   * ```
   */
  async stop(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.logger.info({}, "Stopping Routecraft context");
    this.emit("context:stopping", { reason: undefined });

    // 1. Abort all route controllers (stops sources)
    for (const route of this.routes) {
      this.logger.info({ route: route.definition.id }, "Stopping route");
      const controller = this.controllers.get(route.definition.id);
      controller?.abort("context.stop()");
    }

    // 2. Drain all routes (wait for in-flight handlers + their tasks)
    let drainError: unknown;
    try {
      await Promise.all(this.routes.map((r) => r.drain()));
    } catch (err) {
      drainError = err;
      this.logger.warn(
        { err },
        "Route drain failed during stop(); continuing teardown.",
      );
    }

    // 3. Run plugin teardown (plugins with teardown in reverse order, then registerTeardown callbacks)
    for (let i = this.plugins.length - 1; i >= 0; i--) {
      const plugin = this.plugins[i] as CraftPlugin | undefined;
      if (plugin?.teardown) {
        const pluginId = this.getPluginId(plugin, i);

        // Emit stopping event
        this.emit(`plugin:${pluginId}:stopping` as EventName, {
          pluginId,
          pluginIndex: i,
        });

        try {
          await Promise.resolve(plugin.teardown(this));

          // Emit stopped event
          this.emit(`plugin:${pluginId}:stopped` as EventName, {
            pluginId,
            pluginIndex: i,
          });
        } catch (err) {
          this.logger.warn(
            { err, pluginIndex: i },
            "Plugin teardown threw; continuing with remaining teardowns.",
          );
        }
      }
    }
    for (const fn of this.teardownCallbacks) {
      try {
        await Promise.resolve(fn());
      } catch (err) {
        this.logger.warn(
          { err },
          "Plugin teardown threw; continuing with remaining teardowns.",
        );
      }
    }

    this.logger.info({}, "Routecraft context stopped");
    this.emit("context:stopped", {});

    if (drainError) {
      throw drainError;
    }
  }
}
