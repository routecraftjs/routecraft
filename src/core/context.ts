import { DefaultRoute, type Route, type RouteDefinition } from "./route.ts";

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

export class CraftContext {
  private onStartup?: () => Promise<void> | void;
  private onShutdown?: () => Promise<void> | void;
  private routes: Route[] = [];
  private controllers: Map<string, AbortController> = new Map();
  private store = new Map<
    keyof StoreRegistry,
    StoreRegistry[keyof StoreRegistry]
  >();

  constructor() {}

  setOnStartup(fn: () => Promise<void> | void): void {
    this.onStartup = fn;
  }

  setOnShutdown(fn: () => Promise<void> | void): void {
    this.onShutdown = fn;
  }

  registerRoute(definition: RouteDefinition): void {
    const controller = new AbortController();
    this.controllers.set(definition.id, controller);
    this.routes.push(new DefaultRoute(this, definition, controller));
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
    if (this.onStartup) {
      await this.onStartup();
    }

    // Start all routes and collect results
    return Promise.allSettled(
      this.routes.map(async (route) => {
        try {
          await route.start();
          return { routeId: route.definition.id, success: true as const };
        } catch (error) {
          // Abort the controller for failed routes
          const controller = this.controllers.get(route.definition.id);
          controller?.abort();
          throw error;
        }
      }),
    ).catch((error) => {
      throw error;
    })
      .finally(() => {
        this.stop();
      })
      .then(() => {
        return;
      });
  }

  async stop(): Promise<void> {
    // Abort all route controllers
    for (const controller of this.controllers.values()) {
      controller.abort();
    }

    if (this.onShutdown) {
      await this.onShutdown();
    }
  }
}
