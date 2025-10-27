import { DefaultRoute, type Route, type RouteDefinition } from "./route.ts";
import { error as rcError, RC } from "./error.ts";
import { createLogger, type Logger } from "./logger.ts";
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
 * Configuration options for creating a CraftContext.
 */
export type CraftConfig = {
  /** Initial values for the context store */
  store?: Map<keyof StoreRegistry, StoreRegistry[keyof StoreRegistry]>;
  /** Event handlers to register on context creation */
  on?: Partial<
    Record<EventName, EventHandler<EventName> | EventHandler<EventName>[]>
  >;
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
  public readonly contextId: string = crypto.randomUUID();

  /** Routes registered with this context */
  private routes: Route[] = [];

  /** Abort controllers for each route */
  private controllers: Map<string, AbortController> = new Map();

  /** Storage for adapter configuration and state */
  private store = new Map<
    keyof StoreRegistry,
    StoreRegistry[keyof StoreRegistry]
  >();

  /** Logger for this context */
  public readonly logger: Logger;

  /** Registered event handlers */
  private readonly handlers: Map<EventName, Set<EventHandler<EventName>>> =
    new Map();

  /**
   * Create a new CraftContext instance.
   *
   * @param config Optional configuration for the context
   */
  constructor(config?: CraftConfig) {
    this.logger = createLogger(this);
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
    }
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
        this.logger.warn(err as Error, "Event handler threw");
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
    this.logger.info("Starting Routecraft context");
    this.emit("contextStarting", {});

    this.logger.info("Starting all routes");
    this.emit("contextStarted", {});
    return Promise.allSettled(
      this.routes.map(async (route) => {
        try {
          this.logger.debug(`Starting route "${route.definition.id}"`);
          this.emit("routeStarting", { route });
          await route.start();
          this.logger.debug(`Route "${route.definition.id}" ended.`);
          return { routeId: route.definition.id, success: true as const };
        } catch (error) {
          this.logger.error(
            error,
            `Failed to start route "${route.definition.id}"`,
          );
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
          this.logger.info("All routes have completed. Stopping context...");
          return this.stop();
        } else {
          this.logger.info(
            "Some routes ended or failed, but the context remains active.\n" +
              "Call context.stop() or let other indefinite routes continue.",
          );
          // Do not stop automatically; let other routes run.
          return;
        }
      })
      .catch((error) => {
        this.logger.error(error, "Context start failed");
        this.emit("error", { error });
        throw error;
      });
  }

  /**
   * Stop all routes and shut down the context.
   *
   * This will:
   * 1. Abort all route controllers
   * 2. Run the onShutdown handler if defined
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
    this.logger.info("Stopping Routecraft context");
    this.emit("contextStopping", { reason: undefined });

    // Abort all route controllers (route emits handled by route abort listener)
    for (const route of this.routes) {
      this.logger.debug("Stopping route controller");
      const controller = this.controllers.get(route.definition.id);
      controller?.abort("context.stop()");
    }

    this.logger.info("Routecraft context stopped");
    this.emit("contextStopped", {});
  }
}
