import { type RouteDefinition } from "./route.ts";
import { CraftContext, type StoreRegistry } from "./context.ts";
import { type Destination, type Processor, type Source } from "./adapter.ts";
import { OperationType } from "./exchange.ts";
import { overloads } from "./util.ts";
import { type ProcessStepDefinition, type ToStepDefinition } from "./step.ts";
import { ErrorCode, RouteCraftError } from "./error.ts";

export class ContextBuilder {
  private onStartupHandler?: () => Promise<void> | void;
  private onShutdownHandler?: () => Promise<void> | void;
  private definitions: RouteDefinition[] = [];
  private initialStores = new Map<
    keyof StoreRegistry,
    StoreRegistry[keyof StoreRegistry]
  >();

  constructor() {}

  onStartup(onStartup: () => Promise<void> | void): this {
    this.onStartupHandler = onStartup;
    return this;
  }

  onShutdown(onShutdown: () => Promise<void> | void): this {
    this.onShutdownHandler = onShutdown;
    return this;
  }

  store<K extends keyof StoreRegistry>(key: K, value: StoreRegistry[K]): this {
    this.initialStores.set(key, value);
    return this;
  }

  routes(
    routes: RouteDefinition | RouteDefinition[] | RouteBuilder,
  ): this {
    if (routes instanceof RouteBuilder) {
      this.definitions.push(...routes.build());
    } else if (Array.isArray(routes)) {
      this.definitions.push(...routes);
    } else {
      this.definitions.push(routes);
    }
    return this;
  }

  build(): CraftContext {
    const ctx = new CraftContext();
    if (this.onStartupHandler) {
      ctx.setOnStartup(this.onStartupHandler);
    }
    if (this.onShutdownHandler) {
      ctx.setOnShutdown(this.onShutdownHandler);
    }

    // Initialize stores with type safety
    for (const [key, value] of this.initialStores) {
      ctx.setStore(key, value);
    }

    // Register routes
    for (const definition of this.definitions) {
      ctx.registerRoute(definition);
    }

    return ctx;
  }
}

export class RouteBuilder {
  private currentRoute?: RouteDefinition;
  private routes: RouteDefinition[] = [];

  constructor() {}

  from(options: Pick<RouteDefinition, "id">, source: Source): this;
  from(source: Source): this;
  from(
    optionsOrSource: Pick<RouteDefinition, "id"> | Source,
    maybeSource?: Source,
  ): this {
    const { options, main: source } = overloads(
      optionsOrSource,
      maybeSource,
      () => {
        return {
          id: crypto.randomUUID().toString(),
        };
      },
    );
    this.currentRoute = {
      id: options.id,
      source: {
        operation: OperationType.FROM,
        subscribe: source.subscribe.bind(source),
      },
      steps: [],
    };
    this.routes.push(this.currentRoute);
    return this;
  }

  private requireSource(): RouteDefinition {
    if (!this.currentRoute) {
      throw new RouteCraftError({
        code: ErrorCode.MISSING_FROM_DEFINITION,
        message: "Missing FROM definition",
        suggestion: "Call from() before adding steps",
      });
    }
    return this.currentRoute;
  }

  process(processor: Processor): this {
    const route = this.requireSource();
    const step: ProcessStepDefinition = {
      operation: OperationType.PROCESS,
      process: processor.process.bind(processor),
    };
    route.steps.push(step);
    return this;
  }

  to(destination: Destination): this {
    const route = this.requireSource();
    const step: ToStepDefinition = {
      operation: OperationType.TO,
      send: destination.send.bind(destination),
    };
    route.steps.push(step);
    return this;
  }

  build(): RouteDefinition[] {
    return this.routes;
  }
}
