import { type RouteDefinition } from "./route.ts";
import { CraftContext, type StoreRegistry } from "./context.ts";
import {
  type Destination,
  type Processor,
  type Source,
  type Splitter,
  type Aggregator,
  type Adapter,
  type CallableProcessor,
  type CallableDestination,
  type CallableSplitter,
  type CallableAggregator,
  type CallableSource,
  type CallableTransformer,
  type Transformer,
  type Tap,
  type CallableTap,
} from "./adapter.ts";
import { ErrorCode, RouteCraftError } from "./error.ts";
import { logger } from "./logger.ts";
import {
  ProcessStep,
  ToStep,
  SplitStep,
  AggregateStep,
  TransformStep,
  TapStep,
  type StepDefinition,
} from "./step.ts";
import {
  SimpleConsumer,
  type Consumer,
  type ConsumerType,
} from "./consumer.ts";

export class ContextBuilder {
  protected onStartupHandler?: () => Promise<void> | void;
  protected onShutdownHandler?: () => Promise<void> | void;
  protected definitions: RouteDefinition[] = [];
  protected initialStores = new Map<
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

  routes(routes: RouteDefinition | RouteDefinition[] | RouteBuilder): this {
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
    ctx.registerRoutes(...this.definitions);

    return ctx;
  }
}

export type RouteOptions = Partial<Pick<RouteDefinition, "consumer">> & {
  id: string;
};

export class RouteBuilder {
  protected currentRoute?: RouteDefinition;
  protected routes: RouteDefinition[] = [];

  constructor() {}

  from<T>(
    optionsOrMain:
      | (Source<T> | CallableSource<T>)
      | [RouteOptions, Source<T> | CallableSource<T>],
  ): this {
    const { options, main: source } = Array.isArray(optionsOrMain)
      ? { options: optionsOrMain[0], main: optionsOrMain[1] }
      : {
          options: { id: crypto.randomUUID().toString() },
          main: optionsOrMain,
        };

    logger.info(`Creating route definition with id "${options.id}"`);

    this.currentRoute = {
      id: options.id,
      source: typeof source === "function" ? { subscribe: source } : source,
      steps: [],
      consumer: {
        type:
          options.consumer?.type ||
          (SimpleConsumer as unknown as ConsumerType<Consumer>),
        options: options.consumer?.options,
      },
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

  private addStep<T extends Adapter>(step: StepDefinition<T>): this {
    const route = this.requireSource();
    logger.info(`Adding ${step.operation} step to route "${route.id}"`);
    route.steps.push(step);
    return this;
  }

  process<T>(processor: Processor<T> | CallableProcessor<T>): this {
    return this.addStep(new ProcessStep<T>(processor));
  }

  to<T>(destination: Destination<T> | CallableDestination<T>): this {
    const route = this.requireSource();
    logger.info(`Adding destination step to route "${route.id}"`);
    route.steps.push(new ToStep<T>(destination));
    return this;
  }

  split<T, R>(splitter: Splitter<T, R> | CallableSplitter<T, R>): this {
    const route = this.requireSource();
    logger.info(`Adding split step to route "${route.id}"`);
    route.steps.push(new SplitStep<T, R>(splitter));
    return this;
  }

  aggregate<T, R>(
    aggregator: Aggregator<T, R> | CallableAggregator<T, R>,
  ): this {
    const route = this.requireSource();
    logger.info(`Adding aggregate step to route "${route.id}"`);
    route.steps.push(new AggregateStep<T, R>(aggregator));
    return this;
  }

  build(): RouteDefinition[] {
    logger.info(`Building ${this.routes.length} routes`);
    return this.routes;
  }

  transform<T>(transformer: Transformer<T> | CallableTransformer<T>): this {
    return this.addStep(new TransformStep<T>(transformer));
  }

  tap<T>(tap: Tap<T> | CallableTap<T>): this {
    return this.addStep(new TapStep<T>(tap));
  }
}
