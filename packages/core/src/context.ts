import { DefaultRoute, type Route, type RouteDefinition } from "./route.ts";
import { RouteCraftError, ErrorCode } from "./error.ts";
import { createLogger, type Logger } from "./logger.ts";
/**
 * Base store registry that can be extended by adapters
 *
 * @example
 * ```typescript
 * // Extend the store registry with channel adapter types
 * declare module "@routecraft/core" {
 *   interface StoreRegistry {
 *     "routecraft.adapter.channel.store": Map<string, MessageChannel>;
 *     "routecraft.adapter.channel.config" Partial<ChannelAdapterOptions>;
 *   }
 * }
 * ```
 */
export interface StoreRegistry {
  [key: `${string}.${string}.${string}`]: unknown;
}

export type MergedOptions<T> = {
  options: Partial<T>;
  mergedOptions(context: CraftContext): T;
};

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export class CraftContext {
  public readonly contextId: string = crypto.randomUUID();
  private onStartup?: () => Promise<void> | void;
  private onShutdown?: () => Promise<void> | void;
  private routes: Route[] = [];
  private controllers: Map<string, AbortController> = new Map();
  private store = new Map<
    keyof StoreRegistry,
    StoreRegistry[keyof StoreRegistry]
  >();
  public readonly logger: Logger;

  constructor() {
    this.logger = createLogger(this);
  }

  setOnStartup(fn: () => Promise<void> | void): void {
    this.onStartup = fn;
  }

  setOnShutdown(fn: () => Promise<void> | void): void {
    this.onShutdown = fn;
  }

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

      throw new RouteCraftError({
        code: ErrorCode.DUPLICATE_ROUTE_DEFINITION,
        message: `Duplicate route ID found: ${duplicateId}`,
        suggestion: "Ensure all route IDs are unique",
      });
    }

    // 5) Register each definition now that there's no duplication
    for (const definition of definitions) {
      const controller = new AbortController();
      this.controllers.set(definition.id, controller);
      this.routes.push(new DefaultRoute(this, definition, controller));
    }
  }

  getRoutes(): Route[] {
    return this.routes;
  }

  getStore<K extends keyof StoreRegistry>(
    key: K,
  ): StoreRegistry[K] | undefined {
    const value = this.store.get(key);
    return value as StoreRegistry[K] | undefined;
  }

  setStore<K extends keyof StoreRegistry>(
    key: K,
    value: StoreRegistry[K],
  ): void {
    this.store.set(key, value);
  }

  getRouteById(id: string): Route | undefined {
    return this.routes.find((route) => route.definition.id === id);
  }

  async start(): Promise<void> {
    this.logger.info("Starting Routecraft context");

    if (this.onStartup) {
      this.logger.debug("Running startup handler");
      await this.onStartup();
    }

    this.logger.info("Starting all routes");
    return Promise.allSettled(
      this.routes.map(async (route) => {
        try {
          this.logger.debug(`Starting route "${route.definition.id}"`);
          await route.start();
          this.logger.debug(`Route "${route.definition.id}" ended.`);
          return { routeId: route.definition.id, success: true as const };
        } catch (error) {
          this.logger.error(
            `Failed to start route "${route.definition.id}"`,
            error,
          );
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
        this.logger.error("Context start failed with error:", error);
        throw error;
      });
  }

  async stop(): Promise<void> {
    this.logger.info("Stopping Routecraft context");

    // Abort all route controllers
    for (const controller of this.controllers.values()) {
      this.logger.debug("Stopping route controller");
      controller.abort();
    }

    if (this.onShutdown) {
      this.logger.debug("Running shutdown handler");
      await this.onShutdown();
    }

    this.logger.info("Routecraft context stopped");
  }
}
