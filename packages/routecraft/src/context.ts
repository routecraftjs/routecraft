import { randomUUID } from "node:crypto";
import { BRAND } from "./brand.ts";
import { ContextBuilder } from "./builder.ts";
import { DefaultRoute, type Route, type RouteDefinition } from "./route.ts";
import { error as rcError, RC } from "./error.ts";
import { isRouteCraftError } from "./brand.ts";
import { logger, childBindings } from "./logger.ts";
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
 *     "routecraft.adapter.channel.config" Partial<ChannelAdapterOptions>;
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
 * Reserved config for direct adapter (future: channel type, whitelist, timeouts).
 * No-op today; used by built-in direct handling when implemented.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Reserved for future options.
export interface DirectConfig {}

/**
 * Reserved config for HTTP (future: inbound server port, host).
 * No-op today; used by built-in HTTP server when implemented.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Reserved for future options.
export interface HttpConfig {}

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
  /** Plugins to run before routes are registered (call initPlugins() then registerRoutes) */
  plugins?: CraftPlugin[];
  /** Reserved: direct adapter / channel config (no-op today) */
  direct?: DirectConfig;
  /** Reserved: HTTP server config for inbound (no-op today) */
  http?: HttpConfig;
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
 *     contextStarting: async () => {
 *       console.log('Starting application');
 *     },
 *     contextStopping: async () => {
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

  /** Plugins from config, run by initPlugins() before routes are registered */
  private readonly plugins: CraftPlugin[] = [];

  /** Teardown callbacks registered by plugins; run during stop() after contextStopped */
  private readonly teardownCallbacks: Array<() => void | Promise<void>> = [];

  /**
   * Create a new CraftContext instance.
   *
   * @param config Optional configuration for the context
   */
  constructor(config?: CraftConfig) {
    (this as unknown as Record<symbol, boolean>)[BRAND.CraftContext] = true;
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
      if (config.plugins?.length) {
        this.plugins.push(...config.plugins);
      }
    }
  }

  /**
   * Run plugins from config. Call this before registerRoutes() so plugins can
   * set up state or dynamically add routes. Fails fast: on first plugin error,
   * logs, emits "error", and rethrows to abort remaining plugins.
   */
  async initPlugins(): Promise<void> {
    for (const [pluginIndex, plugin] of this.plugins.entries()) {
      try {
        if (
          !plugin ||
          typeof plugin !== "object" ||
          typeof (plugin as CraftPlugin).apply !== "function"
        ) {
          this.logger.error(
            { pluginIndex },
            "Invalid plugin: expected object with apply(ctx) method. See CraftPlugin type.",
          );
          continue;
        }
        await (plugin as CraftPlugin).apply(this);
      } catch (err) {
        this.logger.error(
          { pluginIndex, err },
          "Plugin threw during initPlugins. Check stack and plugin implementation.",
        );
        this.emit("error", { error: err });
        throw err;
      }
    }
  }

  /**
   * Register a teardown callback to run when the context stops. Plugins use this
   * to release resources (e.g. caches, native handles) after routes have drained.
   * Callbacks run in registration order after "contextStopped" is emitted.
   */
  registerTeardown(fn: () => void | Promise<void>): void {
    this.teardownCallbacks.push(fn);
  }

  /**
   * Subscribe to lifecycle and system events.
   *
   * Handlers receive payloads with shape { ts, context, details }.
   */
  on<K extends EventName>(event: K, handler: EventHandler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    // Force type casting at storage time; retrieval re-casts on emit
    set.add(handler as unknown as EventHandler<EventName>);
    this.handlers.set(event, set);
    return () => {
      set.delete(handler as unknown as EventHandler<EventName>);
    };
  }

  /**
   * Emit an event to registered handlers. Public for internal use by routes/adapters.
   */
  emit<K extends EventName>(
    event: K,
    details: EventPayload<K>["details"],
  ): void {
    const payload: EventPayload<K> = {
      ts: new Date().toISOString(),
      context: this,
      details,
    } as EventPayload<K>;
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    for (const handler of Array.from(set)) {
      try {
        void (handler as unknown as EventHandler<K>)(payload);
      } catch (err) {
        // Swallow handler errors but log them and emit system error
        this.logger.warn(
          { event, err },
          "Event handler threw. Handler should not throw; errors are emitted as context 'error' event.",
        );
        if (event !== "error") {
          this.emit("error", { error: err });
        }
      }
    }
  }

  // onStartup/onShutdown removed in favor of event listeners

  /**
   * Register routes with this context.
   *
   * @param definitions Route definitions to register
   * @throws {RouteCraftError} If there are duplicate route IDs or invalid route definitions
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
      // Event: routeRegistered
      this.emit("routeRegistered", { route });
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
   * This will:
   * 1. Run the onStartup handler if defined
   * 2. Start all routes in parallel
   * 3. Wait for all routes to complete if they're not indefinite
   * 4. Automatically stop the context if all routes complete
   *
   * @returns A promise that resolves when all routes have started
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
    this.logger.info(
      { routeCount: this.routes.length },
      "Starting Routecraft context",
    );
    this.emit("contextStarting", {});

    this.logger.debug({}, "Starting all routes");
    this.emit("contextStarted", {});
    return Promise.allSettled(
      this.routes.map(async (route) => {
        try {
          this.logger.info({ route: route.definition.id }, "Starting route");
          this.emit("routeStarting", { route });
          await route.start();
          this.logger.info({ route: route.definition.id }, "Route stopped");
          return { routeId: route.definition.id, success: true as const };
        } catch (error) {
          const msg = isRouteCraftError(error)
            ? (error as { meta: { message: string } }).meta.message
            : error instanceof Error
              ? error.message
              : "Route failed to start";
          this.logger.fatal({ route: route.definition.id, err: error }, msg);
          this.emit("error", { error, route });
          // Abort just this failing route
          const controller = this.controllers.get(route.definition.id);
          controller?.abort();
          throw error;
        }
      }),
    )
      .then((results) => {
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
        const msg = isRouteCraftError(error)
          ? (error as { meta: { message: string } }).meta.message
          : error instanceof Error
            ? error.message
            : "Context start failed";
        this.logger.fatal({ err: error }, msg);
        this.emit("error", { error });
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
    this.logger.info({}, "Stopping Routecraft context");
    this.emit("contextStopping", { reason: undefined });

    // 1. Abort all route controllers (stops sources)
    for (const route of this.routes) {
      this.logger.info({ route: route.definition.id }, "Stopping route");
      const controller = this.controllers.get(route.definition.id);
      controller?.abort("context.stop()");
    }

    // 2. Drain all routes (wait for in-flight handlers + their tasks)
    await Promise.all(this.routes.map((r) => r.drain()));

    this.logger.info({}, "Routecraft context stopped");
    this.emit("contextStopped", {});

    // 3. Run plugin teardown (plugins with teardown in reverse order, then registerTeardown callbacks)
    for (let i = this.plugins.length - 1; i >= 0; i--) {
      const plugin = this.plugins[i] as CraftPlugin | undefined;
      if (plugin?.teardown) {
        try {
          await Promise.resolve(plugin.teardown(this));
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
  }
}

/**
 * Create a new context builder.
 *
 * This is the entry point for creating a new application context.
 *
 * @returns A new ContextBuilder instance
 *
 * @example
 * ```typescript
 * // Create and configure a context
 * const ctx = context()
 *   .routes(myRoute)
 *   .on('contextStarting', () => console.log('Starting...'))
 *   .build();
 *
 * // Start processing
 * await ctx.start();
 * ```
 */
export function context(): ContextBuilder {
  return new ContextBuilder();
}
