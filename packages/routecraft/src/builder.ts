import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { BRAND, isRouteBuilder, setBrand } from "./brand.ts";
import { StepBuilderBase } from "./step-builder-base.ts";
import {
  type RouteDefinition,
  type ErrorHandler,
  type RouteDiscovery,
  type RouteSchemas,
} from "./route.ts";
import {
  CraftContext,
  type StoreRegistry,
  type CraftConfig,
} from "./context.ts";
import { rcError } from "./error.ts";
import { logger } from "./logger.ts";
import { CraftClient } from "./client.ts";
import { type EventHandler, type EventName } from "./types.ts";
import { SimpleConsumer } from "./consumers/simple.ts";
import { BatchConsumer } from "./consumers/batch.ts";
import { type Source, type CallableSource } from "./operations/from.ts";
import {
  type Adapter,
  type Step,
  type Consumer,
  type ConsumerType,
} from "./types.ts";
import {
  type Exchange,
  DefaultExchange,
  getExchangeContext,
} from "./exchange.ts";
import { MailClientManager } from "./adapters/mail/client-manager.ts";
import { MAIL_CLIENT_MANAGER } from "./adapters/mail/shared.ts";
import { telemetry } from "./telemetry/index.ts";
import {
  type Splitter,
  type CallableSplitter,
  SplitStep,
} from "./operations/split.ts";
import {
  type Aggregator,
  type CallableAggregator,
  AggregateStep,
  defaultAggregate,
} from "./operations/aggregate.ts";
import { COLLECT_STEPS } from "./dsl-symbol.ts";
import { ChoiceStep, ChoiceSubBuilder } from "./operations/choice.ts";

/**
 * Builder for creating a Routecraft context with routes and configuration.
 *
 * This builder provides a fluent API for configuring and creating a CraftContext
 * with routes, startup/shutdown handlers, and initial store values.
 *
 * @example
 * ```typescript
 * // Create a context with routes and handlers
 * const { context, client } = await new ContextBuilder()
 *   .with({ store: new Map() })
 *   .on('context:starting', ({ ts }) => console.log('Starting at', ts))
 *   .store('routecraft.adapter.channel.store', new Map())
 *   .routes(routes1)
 *   .routes([routes2, routes3])
 *   .build();
 *
 * // Start the context to begin processing
 * await context.start();
 *
 * // Dispatch messages programmatically
 * await client.send('my-endpoint', { data: 'hello' });
 * ```
 *
 * Plugins run before routes are registered, allowing them to:
 * - Set up stores and state
 * - Dynamically register additional routes
 * - Subscribe to lifecycle events
 * - Perform other initialization
 */
export class ContextBuilder {
  protected config?: CraftConfig;
  protected definitions: RouteDefinition[] = [];
  protected initialStores = new Map<
    keyof StoreRegistry,
    StoreRegistry[keyof StoreRegistry]
  >();
  protected eventHandlers = new Map<EventName, Set<EventHandler<EventName>>>();
  protected onceHandlers = new Map<EventName, Set<EventHandler<EventName>>>();
  protected plugins: Array<import("./context.ts").CraftPlugin> = [];
  protected mailConfig?: import("./adapters/mail/types.ts").MailContextConfig;

  constructor() {}

  /**
   * Configure the context with the provided config object.
   *
   * @param config The configuration object for the context
   * @returns This builder instance for method chaining
   */
  with(config: CraftConfig): this {
    this.config = config;

    // Extract store entries if provided
    if (config.store) {
      for (const [key, value] of config.store.entries()) {
        this.initialStores.set(key, value);
      }
    }

    // Extract event handlers if provided
    if (config.on) {
      for (const [event, handler] of Object.entries(config.on)) {
        const eventName = event as EventName;
        if (Array.isArray(handler)) {
          handler.forEach((h) => {
            const set = this.eventHandlers.get(eventName) ?? new Set();
            set.add(h as EventHandler<EventName>);
            this.eventHandlers.set(eventName, set);
          });
        } else if (handler) {
          const set = this.eventHandlers.get(eventName) ?? new Set();
          set.add(handler as EventHandler<EventName>);
          this.eventHandlers.set(eventName, set);
        }
      }
    }

    // Note: config.once handlers are registered by the CraftContext constructor directly,
    // so we do not copy them into onceHandlers here to avoid double-registration.

    // Note: config.cron and config.direct are handled by the CraftContext
    // constructor directly -- no extraction needed here.

    // Extract mail config if provided
    if (config.mail) {
      this.mailConfig = config.mail;
    }

    // Convert telemetry config into a plugin
    if (config.telemetry) {
      this.plugins.push(telemetry(config.telemetry));
    }

    // Extract plugins if provided
    if (config.plugins) {
      this.plugins.push(...config.plugins);
    }

    return this;
  }

  // binders(...) API removed

  /**
   * Register an event listener to be attached to the built context.
   */
  on<K extends EventName>(event: K, handler: EventHandler<K>): this {
    const set = this.eventHandlers.get(event) ?? new Set();
    set.add(handler as unknown as EventHandler<EventName>);
    this.eventHandlers.set(event, set);
    return this;
  }

  /**
   * Register a one-time event listener to be attached to the built context.
   * The handler fires once and then auto-unsubscribes.
   */
  once<K extends EventName>(event: K, handler: EventHandler<K>): this {
    const set = this.onceHandlers.get(event) ?? new Set();
    set.add(handler as unknown as EventHandler<EventName>);
    this.onceHandlers.set(event, set);
    return this;
  }

  /**
   * Add an initial value to the context store.
   *
   * @template K The store key type
   * @param key The store key
   * @param value The initial value for the store
   * @returns This builder instance for method chaining
   *
   * @example
   * ```typescript
   * // Add an initial channel store
   * builder.store('routecraft.adapter.channel.store', new Map());
   * ```
   */
  store<K extends keyof StoreRegistry>(key: K, value: StoreRegistry[K]): this {
    this.initialStores.set(key, value);
    return this;
  }

  /**
   * Add routes to the context.
   *
   * Routes can be added as individual RouteDefinitions, RouteBuilders, or arrays of either.
   * RouteBuilder-like objects (duck-typed by having a .build() that returns RouteDefinition[])
   * are supported so that builders from another copy of the package (e.g. CLI vs user module)
   * are still recognized.
   *
   * @param routes Individual or array of route definitions/builders to add
   * @returns This builder instance for method chaining
   *
   * @example
   * ```typescript
   * // Add a single route
   * builder.routes(myRoute);
   *
   * // Add multiple routes
   * builder.routes([route1, route2, route3]);
   *
   * // Add a route builder
   * builder.routes(
   *   craft()
   *     .from(simple("hello"))
   *     .to(log())
   * );
   * ```
   */
  routes(
    routes:
      | RouteDefinition[]
      | RouteBuilder<unknown>[]
      | RouteDefinition
      | RouteBuilder<unknown>,
  ): this {
    const addOne = (route: RouteDefinition | RouteBuilder<unknown>): void => {
      if (isRouteBuilder(route)) {
        this.definitions.push(
          ...(route as { build: () => RouteDefinition[] }).build(),
        );
      } else {
        this.definitions.push(route as RouteDefinition);
      }
    };

    if (Array.isArray(routes)) {
      routes.forEach(addOne);
    } else {
      addOne(routes);
    }
    return this;
  }

  /**
   * Build and return a configured CraftContext and CraftClient.
   *
   * This finalizes the configuration, runs plugins, and creates a ready-to-use
   * context with all the configured routes, handlers, and store values.
   * The client provides a programmatic API for dispatching messages into routes.
   *
   * @returns A promise resolving to `{ context, client }`
   *
   * @example
   * ```typescript
   * const { context, client } = await new ContextBuilder()
   *   .routes(capabilities)
   *   .build();
   *
   * await context.start();
   * await client.send('greet', { name: 'World' });
   * ```
   */
  async build(): Promise<{ context: CraftContext; client: CraftClient }> {
    const configWithPlugins = {
      ...this.config,
      plugins: this.plugins,
    };
    const ctx = new CraftContext(configWithPlugins);

    // Add stores from builder (config stores already added in constructor)
    for (const [key, value] of this.initialStores) {
      if (!this.config?.store?.has(key)) {
        ctx.setStore(key, value);
      }
    }

    // Attach event handlers from builder (config handlers already added in constructor)
    for (const [event, handlers] of this.eventHandlers.entries()) {
      for (const handler of handlers) {
        ctx.on(event as EventName, handler as EventHandler<EventName>);
      }
    }

    // Attach one-time event handlers from builder (config once handlers already added in constructor)
    for (const [event, handlers] of this.onceHandlers.entries()) {
      for (const handler of handlers) {
        ctx.once(event as EventName, handler as EventHandler<EventName>);
      }
    }

    // Note: cron and direct defaults are set by the CraftContext constructor
    // via config.cron / config.direct -- no need to set them again here.

    // Set up mail client manager if mail config is present
    if (this.mailConfig) {
      const manager = new MailClientManager(this.mailConfig);
      ctx.setStore(MAIL_CLIENT_MANAGER as keyof StoreRegistry, manager);
      ctx.registerTeardown(() => manager.drain());
    }

    // Run plugins before routes are registered (context runs config.plugins)
    await ctx.initPlugins();

    // Register all routes from builder
    ctx.registerRoutes(...this.definitions);

    return { context: ctx, client: new CraftClient(ctx) };
  }
}

/**
 * Options for configuring a route.
 */
export type RouteOptions = Partial<Pick<RouteDefinition, "consumer">> & {
  /**
   * Unique identifier for the route.
   */
  id: string;
};

/**
 * Builder for creating route definitions with a fluent API.
 *
 * This builder provides methods for defining the steps in a route,
 * including sources, transformations, filters, destinations, and more.
 *
 * The type parameter tracks the data type flowing through the route
 * at each step, providing type safety throughout the route definition.
 *
 * @template Current The type of data currently flowing through the route
 *
 * @example
 * ```typescript
 * // Create a simple route that processes a string
 * const route = craft()
 *   .from(simple("Hello, World!"))
 *   .transform(msg => msg.toUpperCase())
 *   .to(log())
 * ```
 */
export class RouteBuilder<Current = unknown> extends StepBuilderBase<Current> {
  protected currentRoute?: RouteDefinition;
  protected routes: RouteDefinition[] = [];

  // Pending options set via .id() / .batch() / .error() / .description() / ... before .from()
  protected pendingOptions?:
    | {
        id?: string;
        consumer?: {
          type: ConsumerType<Consumer>;
          options?: unknown;
        };
        errorHandler?: ErrorHandler;
        discovery?: RouteDiscovery;
      }
    | undefined;

  constructor() {
    super();
    setBrand(this, BRAND.RouteBuilder);
  }

  /**
   * Set the route id for the next route to be created.
   * Stages the id; does not affect the current route if one already exists.
   *
   * @param id - Unique route identifier (used in logs and context.getRouteById())
   * @returns This builder for chaining
   *
   * @example
   * ```typescript
   * craft().id('ingest-api').from(httpServer({ path: '/ingest' })).to(log()).build();
   * ```
   */
  id(id: string): this {
    this.pendingOptions = { ...(this.pendingOptions ?? {}), id };
    logger.trace({ route: id }, "Staging route id for next route");
    return this;
  }

  /**
   * Set a human-readable title for the next route. Mirrored into the
   * direct / mcp registries so discovery consumers (agents, docs) can
   * display it alongside the id.
   */
  title(value: string): this {
    this.mergeDiscovery({ title: value });
    return this;
  }

  /**
   * Set a human-readable description for the next route. Used by
   * discovery-aware adapters when exposing the route to external consumers
   * (agents, MCP clients).
   */
  description(value: string): this {
    this.mergeDiscovery({ description: value });
    return this;
  }

  /**
   * Declare input schemas for the next route. The engine validates incoming
   * message bodies and headers against these schemas before any pipeline
   * step runs; a validation failure emits `exchange:dropped` and the
   * pipeline never sees the message. Accepts either a bundle
   * (`{ body, headers }`) or a bare Standard Schema as a body-only shorthand.
   * To flow the body type through the chain, pass it as a generic on
   * `.from<T>(source)` after the `.input()` call.
   */
  input(schemas: RouteSchemas | StandardSchemaV1): this {
    this.mergeDiscovery({ input: this.normalizeSchemas(schemas) });
    return this;
  }

  /**
   * Declare output schemas for the next route. The engine validates the
   * final exchange against these schemas before the primary destination
   * fires; a validation failure is routed to the error handler. Accepts
   * either a bundle (`{ body, headers }`) or a bare Standard Schema as a
   * body-only shorthand.
   */
  output(schemas: RouteSchemas | StandardSchemaV1): this {
    this.mergeDiscovery({ output: this.normalizeSchemas(schemas) });
    return this;
  }

  private mergeDiscovery(partial: Partial<RouteDiscovery>): void {
    this.pendingOptions = {
      ...(this.pendingOptions ?? {}),
      discovery: { ...(this.pendingOptions?.discovery ?? {}), ...partial },
    };
  }

  private normalizeSchemas(
    value: RouteSchemas | StandardSchemaV1,
  ): RouteSchemas {
    return "~standard" in value ? { body: value as StandardSchemaV1 } : value;
  }

  /**
   * Configure batch processing for the next route to be created.
   * Stages the batch consumer; does not affect the current route if one already exists.
   *
   * @param options - Optional `size` (batch size) and `flushIntervalMs` (flush interval)
   * @returns This builder for chaining
   *
   * @example
   * ```typescript
   * craft().batch({ size: 10, flushIntervalMs: 1000 }).from(timer(1000)).to(log()).build();
   * ```
   */
  batch(options?: { size?: number; flushIntervalMs?: number }): this {
    const mapped = {
      size: options?.size,
      time: options?.flushIntervalMs,
    } as unknown;
    this.pendingOptions = {
      ...(this.pendingOptions ?? {}),
      consumer: {
        type: BatchConsumer as unknown as ConsumerType<Consumer>,
        options: mapped,
      },
    };
    logger.trace("Staging batch processing for next route");
    return this;
  }

  /**
   * Define a catch-all error handler for unhandled errors in the route's step pipeline.
   *
   * Must be called before `.from()`. When any step throws an unhandled error, this handler
   * is invoked instead of the default log-and-swallow behavior. The pipeline does not resume
   * after the handler runs; its return value becomes the route's final exchange body.
   *
   * @param handler - Receives the error, the exchange at the point of failure, and a `forward`
   *   function to delegate to another route via the direct adapter.
   * @returns This builder for chaining
   *
   * @example
   * ```typescript
   * craft()
   *   .id('process-orders')
   *   .error((error, exchange, forward) => {
   *     return forward('error-route', { reason: error.message })
   *   })
   *   .from(timer({ intervalMs: 60000 }))
   *   .to(dangerousDestination)
   * ```
   */
  error(handler: ErrorHandler): this {
    this.pendingOptions = {
      ...(this.pendingOptions ?? {}),
      errorHandler: handler,
    };
    logger.trace("Staging error handler for next route");
    return this;
  }

  /**
   * Define the source of data for this route.
   * This is typically the first step in defining a route.
   *
   * @template T The type of data produced by the source
   * @param source A source adapter or function
   * @returns A RouteBuilder with the specified type T
   * @example
   * // Simple source with inferred type
   * .from<string[]>(httpServer({ path: '/api/data' }))
   *
   * // Source with callable function
   * .from<User[]>(async () => {
   *   const response = await fetch('https://api.example.com/users');
   *   return response.json();
   * })
   *
   * // After `.input({ body: schema })`, pass the inferred body type to
   * // flow it through the chain:
   * // .input({ body: MySchema }).from<z.infer<typeof MySchema>>(direct())
   */
  from<T>(source: Source<T> | CallableSource<T>): RouteBuilder<T>;
  from<T>(source: Source<unknown> | CallableSource<unknown>): RouteBuilder<T>;
  from<T>(source: Source<T> | CallableSource<T>): RouteBuilder<T> {
    const id = this.pendingOptions?.id ?? randomUUID();
    const consumer = this.pendingOptions?.consumer ?? {
      type: SimpleConsumer as unknown as ConsumerType<Consumer>,
      options: undefined,
    };
    const errorHandler = this.pendingOptions?.errorHandler;
    const discovery = this.pendingOptions?.discovery;

    logger.trace({ route: id }, "Creating route definition");

    this.currentRoute = {
      id,
      source: typeof source === "function" ? { subscribe: source } : source,
      steps: [],
      consumer: {
        type: consumer.type,
        options: consumer.options ?? undefined,
      },
      ...(errorHandler ? { errorHandler } : {}),
      ...(discovery ? { discovery } : {}),
    };
    setBrand(this.currentRoute, BRAND.RouteDefinition);

    // Clear staged options once used
    this.pendingOptions = undefined;

    this.routes.push(this.currentRoute);
    return this.retype<T>();
  }

  /**
   * Internal method to ensure a source has been defined for the current route.
   * Throws an error if no source has been defined.
   *
   * @returns The current route definition
   * @throws Error if no source has been defined
   * @private
   */
  private requireSource(): RouteDefinition {
    if (!this.currentRoute) {
      throw rcError("RC2002");
    }
    return this.currentRoute;
  }

  /**
   * Append a step to the current route. Implements the abstract hook from
   * {@link StepBuilderBase}, so every inherited pipeline operation (and
   * every registered DSL sugar) flows through this method. The route-only
   * operations that stay on `RouteBuilder` (`split`, `aggregate`, `choice`)
   * call it too.
   *
   * @param step - The step to append
   * @throws {RoutecraftError} RC2002 if `.from()` has not been called yet
   */
  protected override pushStep<T extends Adapter>(step: Step<T>): void {
    const route = this.requireSource();
    logger.trace(
      { operation: step.operation, route: route.id },
      "Adding step to route",
    );
    route.steps.push(step);
  }

  /**
   * Split into multiple exchanges for fan-out. Each returned exchange is processed independently.
   * If no splitter is provided: array bodies are split into one exchange per element; non-array bodies
   * are treated as a single item (one exchange). Framework maintains `routecraft.split_hierarchy`
   * headers for aggregation.
   *
   * @template ItemType The type of items in the array (inferred from array if not specified)
   * @param splitter Optional adapter or function (exchange) => Exchange<ItemType>[]
   * @returns A RouteBuilder with the item type
   * @example
   * // Automatically split an array of numbers
   * .from<number[]>(source)
   * .split() // ItemType is inferred as number
   *
   * // Custom splitting logic - exchange-aware
   * .from(source)
   * .split<User>((exchange) => exchange.body.users.map(body =>
   *   new DefaultExchange(getExchangeContext(exchange)!, { body, headers: exchange.headers })))
   *
   * // Split a string by delimiter (return exchanges)
   * .split<string>((exchange) => exchange.body.split(",").map(body => new DefaultExchange(getExchangeContext(exchange)!, { body, headers: exchange.headers })))
   */
  split<ItemType = Current extends Array<infer U> ? U : Current>(
    splitter?:
      | Splitter<Current, ItemType>
      | CallableSplitter<Current, ItemType>,
  ): RouteBuilder<ItemType> {
    // If no splitter is provided, use default splitter: arrays are split, non-arrays as single item
    if (!splitter) {
      const defaultSplitter: CallableSplitter<Current, ItemType> = (
        exchange,
      ) => {
        const context = getExchangeContext(exchange);
        if (!context) {
          throw rcError("RC5001", undefined, {
            message: "Exchange has no context — cannot execute default split",
          });
        }
        const body = exchange.body;
        if (Array.isArray(body)) {
          return (body as ItemType[]).map(
            (b) =>
              new DefaultExchange(context, {
                body: b,
                headers: exchange.headers,
              }),
          ) as Exchange<ItemType>[];
        }
        return [
          new DefaultExchange(context, {
            body: body as unknown as ItemType,
            headers: exchange.headers,
          }),
        ];
      };

      this.pushStep(new SplitStep<Current, ItemType>(defaultSplitter));
    } else {
      this.pushStep(new SplitStep<Current, ItemType>(splitter));
    }

    return this.retype<ItemType>();
  }

  /**
   * Aggregate multiple items into a single result.
   * This is often used after a split operation to collect and combine the results.
   * If no aggregator is provided, items are collected into an array.
   *
   * @template ResultType The resulting type after aggregation
   * @param aggregator Optional function that combines multiple items into a single result
   * @returns A RouteBuilder with the new aggregated type
   * @example
   * // Automatically collect items into an array
   * .split()
   * .process((exchange) => ({ ...exchange, body: exchange.body * 2 }))
   * .aggregate() // Returns array of processed items
   *
   * // Custom aggregation logic
   * .aggregate<number>((exchanges) => {
   *   const sum = exchanges.reduce((acc, ex) => acc + ex.body, 0);
   *   return { body: sum, headers: exchanges[0].headers };
   * })
   */
  aggregate<ResultType = Current[]>(
    aggregator?:
      | Aggregator<Current, ResultType>
      | CallableAggregator<Current, ResultType>,
  ): RouteBuilder<ResultType> {
    if (!aggregator) {
      // Use default aggregator which collects bodies into an array
      this.pushStep(
        new AggregateStep<Current, ResultType>(
          defaultAggregate as CallableAggregator<Current, ResultType>,
        ),
      );
    } else {
      this.pushStep(new AggregateStep<Current, ResultType>(aggregator));
    }
    return this.retype<ResultType>();
  }

  /**
   * Conditionally route the exchange through one of several branches.
   *
   * Branches are defined in a callback sub-builder, so the `when` / `otherwise`
   * surface is only reachable inside a choice block. Predicates are evaluated
   * in registration order; the first match wins. An optional `otherwise`
   * branch catches exchanges that no `when` matched. If no branch matches and
   * no `otherwise` is registered, the exchange is dropped with
   * `reason: "unmatched"`.
   *
   * By default, a matched branch's steps are inlined before the remaining
   * main-pipeline steps, so the exchange converges back into the main flow
   * after the choice. A branch that ends in `b.halt()` short-circuits: the
   * exchange is dropped with `reason: "halted"` and the main pipeline does
   * not resume for it.
   *
   * All branches must produce exchanges of the same type `Out` (defaults to
   * `Current`), which becomes the body type of the builder after the choice.
   *
   * @template Out - Body type produced by every branch (enforced by the
   *   branch callback return types)
   * @param fn - Callback that populates the choice sub-builder with `when`
   *   and `otherwise` branches
   * @returns A RouteBuilder typed at `Out`
   *
   * @experimental
   * @example
   * ```ts
   * .choice(c => c
   *   .when(ex => ex.body.priority === 'urgent', b => b.to(urgentQueue))
   *   .when(ex => ex.body.amount > 1000,         b => b.to(reviewQueue))
   *   .otherwise(                                b => b.to(errorSink).halt()))
   * .to(finalDest)
   * ```
   */
  choice<Out = Current>(
    fn: (c: ChoiceSubBuilder<Current, Out>) => ChoiceSubBuilder<Current, Out>,
  ): RouteBuilder<Out> {
    const sub = new ChoiceSubBuilder<Current, Out>();
    fn(sub);
    this.pushStep(new ChoiceStep<Current>(sub[COLLECT_STEPS]()));
    return this.retype<Out>();
  }

  /**
   * Finalize and return the route definition(s). Call after defining all steps.
   *
   * @returns Array of RouteDefinition (one per `.from()` in this builder chain)
   *
   * @example
   * ```typescript
   * const definitions = craft()
   *   .from<string[]>(source)
   *   .split()
   *   .process((ex) => ({ ...ex, body: (ex.body as string).toUpperCase() }))
   *   .to(destination)
   *   .build();
   * const { context } = await new ContextBuilder().routes(definitions).build();
   * await context.start();
   * ```
   */
  build(): RouteDefinition[] {
    logger.trace({ routeCount: this.routes.length }, "Building routes");
    return this.routes;
  }
}

/**
 * Create a new route builder.
 *
 * This is the entry point for defining routes in a fluent way.
 *
 * @returns A new RouteBuilder instance
 *
 * @example
 * ```typescript
 * // Define a route that processes data
 * const myRoute = craft()
 *   .from(simple("Hello, World!"))
 *   .transform(data => data.toUpperCase())
 *   .to(log())
 * ```
 */
export function craft(): RouteBuilder {
  return new RouteBuilder();
}
