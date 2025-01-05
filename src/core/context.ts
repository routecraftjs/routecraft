import { Route, RouteDefinition } from "@routecraft/core";

export class CraftContext {
  private onStartup?: () => Promise<void> | void;
  private onShutdown?: () => Promise<void> | void;
  private routes: Route[] = [];
  private unsubscribers: Map<string, () => void> = new Map();

  constructor() {}

  setOnStartup(fn: () => Promise<void> | void): void {
    this.onStartup = fn;
  }

  setOnShutdown(fn: () => Promise<void> | void): void {
    this.onShutdown = fn;
  }

  registerRoute(route: RouteDefinition): void {
    this.routes.push(new Route(this, route));
  }

  getRoutes(): Route[] {
    return this.routes;
  }

  getRouteById(id: string): Route | undefined {
    return this.routes.find((route) => route.definition.id === id);
  }

  async start(): Promise<void> {
    if (this.onStartup) {
      await this.onStartup();
    }

    for (const route of this.routes) {
      this.unsubscribers.set(route.definition.id, await route.subscribe());
    }
  }

  async stop(): Promise<void> {
    for (const unsubscriber of this.unsubscribers.values()) {
      unsubscriber();
    }

    if (this.onShutdown) {
      await this.onShutdown();
    }
  }

  async run(): Promise<void> {
    await this.start();
    await this.stop();
  }
}
