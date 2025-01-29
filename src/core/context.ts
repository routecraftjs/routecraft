import { Route, type RouteDefinition } from "./route.ts";

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
  private unsubscribers: Map<string, () => void> = new Map();
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
    this.routes.push(new Route(this, definition));
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

    // Subscribe to all routes and store their unsubscribe functions
    const unsubscribePromises = this.routes.map(async (route) => {
      const unsubscribe = await route.subscribe();
      this.unsubscribers.set(route.definition.id, unsubscribe);
    });

    // Wait for all routes to be subscribed
    await Promise.all(unsubscribePromises);
  }

  async stop(): Promise<void> {
    // Call all unsubscribe functions and wait for them to complete
    const unsubscribePromises = Array.from(this.unsubscribers.values()).map(
      (unsubscribe) => Promise.resolve(unsubscribe()),
    );
    await Promise.all(unsubscribePromises);

    if (this.onShutdown) {
      await this.onShutdown();
    }
  }

  async run(): Promise<void> {
    await this.start();
    await this.stop();
  }
}
