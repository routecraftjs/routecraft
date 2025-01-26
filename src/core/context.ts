import {
  InMemoryMessageChannel,
  Message,
  MessageChannel,
  MessageChannelFactory,
  Route,
  RouteDefinition,
} from "@routecraft/core";

export class CraftContext {
  private onStartup?: () => Promise<void> | void;
  private onShutdown?: () => Promise<void> | void;
  private channelFactory?: MessageChannelFactory<Message>;
  private routes: Route[] = [];
  private unsubscribers: Map<string, () => void> = new Map();

  constructor() {}

  setOnStartup(fn: () => Promise<void> | void): void {
    this.onStartup = fn;
  }

  setOnShutdown(fn: () => Promise<void> | void): void {
    this.onShutdown = fn;
  }

  registerRoute(definition: RouteDefinition): void {
    this.routes.push(
      new Route(this, definition, this.createMessageChannel(definition.id)),
    );
  }

  getRoutes(): Route[] {
    return this.routes;
  }

  getRouteById(id: string): Route | undefined {
    return this.routes.find((route) => route.definition.id === id);
  }

  private createMessageChannel(
    namespace: string,
  ): MessageChannel<Message> {
    return this.channelFactory
      ? this.channelFactory.create(namespace)
      : new InMemoryMessageChannel<Message>(namespace);
  }

  setChannelFactory(factory: MessageChannelFactory<Message>): void {
    this.channelFactory = factory;
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
