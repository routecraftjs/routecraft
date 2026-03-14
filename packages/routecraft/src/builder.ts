import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { BRAND, ENRICH_MERGE_TYPE, isRouteBuilder, setBrand } from "./brand.ts";
import { type RouteDefinition, type ErrorHandler } from "./route.ts";
import {
  CraftContext,
  type StoreRegistry,
  type CraftConfig,
} from "./context.ts";
import { rcError } from "./error.ts";
import { logger } from "./logger.ts";
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
import {
  type Processor,
  type CallableProcessor,
  ProcessStep,
} from "./operations/process.ts";
import {
  type Destination,
  type CallableDestination,
  ToStep,
} from "./operations/to.ts";
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
import {
  type Transformer,
  type CallableTransformer,
  TransformStep,
} from "./operations/transform.ts";
import { TapStep } from "./operations/tap.ts";
import {
  type CallableFilter,
  type Filter,
  FilterStep,
} from "./operations/filter.ts";
import { ValidateStep } from "./operations/validate.ts";
import {
  EnrichStep,
  type DestinationAggregator,
  type EnrichMergeShape,
} from "./operations/enrich.ts";
import { HeaderStep } from "./operations/header.ts";
import { type HeaderValue } from "./exchange.ts";
// Binder mechanism removed

/**
 * Builder for creating a Routecraft context with routes and configuration.
 *
 * This builder provides a fluent API for configuring and creating a CraftContext
 * with routes, startup/shutdown handlers, and initial store values.
 *
 * @example
 * ```typescript
 * // Create a context with routes and handlers
 * const context = new ContextBuilder()
 *   .with({ store: new Map() })
 *   .on('context:starting', ({ ts }) => console.log('Starting at', ts))
 *   .store('routecraft.adapter.channel.store', new Map())
 *   .routes(routes1)
 *   .routes([routes2, routes3])
 *   .build();
 *
 * // Start the context to begin processing
 * await context.start();
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
  // Binder registry removed

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
      | RouteBuilder<unknown, Record<string, HeaderValue>>[]
      | RouteDefinition
      | RouteBuilder<unknown, Record<string, HeaderValue>>,
  ): this {
    const addOne = (
      route:
        | RouteDefinition
        | RouteBuilder<unknown, Record<string, HeaderValue>>,
    ): void => {
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
   * Build and return a configured CraftContext instance.
   *
   * This finalizes the configuration, runs plugins, and creates a ready-to-use
   * context with all the configured routes, handlers, and store values.
   *
   * @returns A promise that resolves to a new CraftContext instance
   */
  async build(): Promise<CraftContext> {
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

    // Run plugins before routes are registered (context runs config.plugins)
    await ctx.initPlugins();

    // Register all routes from builder
    ctx.registerRoutes(...this.definitions);

    return ctx;
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
export class RouteBuilder<
  Current = unknown,
  Headers extends Record<string, HeaderValue> = Record<string, HeaderValue>,
> {
  protected currentRoute?: RouteDefinition;
  protected routes: RouteDefinition[] = [];

  // Pending options set via .id() / .batch() / .error() before .from()
  protected pendingOptions?:
    | {
        id?: string;
        consumer?: {
          type: ConsumerType<Consumer>;
          options?: unknown;
        };
        errorHandler?: ErrorHandler;
      }
    | undefined;

  constructor() {
    setBrand(this, BRAND.RouteBuilder);
  }

  /**
   * Safe identity cast: same instance, type parameters updated for the next step.
   * Used to propagate body type and tracked headers through the method chain.
   *
   * @template T - The body type for the next step
   * @template H - The tracked headers type for the next step (defaults to current Headers)
   * @returns This builder typed as RouteBuilder<T, H>
   * @private
   */
  private withType<
    T,
    H extends Record<string, HeaderValue> = Headers,
  >(): RouteBuilder<T, H> {
    return this as unknown as RouteBuilder<T, H>;
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
   */
  from<T>(
    source: Source<T> | CallableSource<T>,
  ): RouteBuilder<T, Record<string, HeaderValue>> {
    const id = this.pendingOptions?.id ?? randomUUID();
    const consumer = this.pendingOptions?.consumer ?? {
      type: SimpleConsumer as unknown as ConsumerType<Consumer>,
      options: undefined,
    };
    const errorHandler = this.pendingOptions?.errorHandler;

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
    };
    setBrand(this.currentRoute, BRAND.RouteDefinition);

    // Clear staged options once used
    this.pendingOptions = undefined;

    this.routes.push(this.currentRoute);
    return this.withType<T, Record<string, HeaderValue>>();
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
   * Internal method to add a step to the current route.
   * This is used by the public methods to build up the route definition.
   *
   * @template T The type of adapter used by the step
   * @param step The step definition to add
   * @returns The current RouteBuilder instance
   * @private
   */
  private addStep<T extends Adapter>(
    step: Step<T>,
  ): RouteBuilder<Current, Headers> {
    const route = this.requireSource();
    logger.trace(
      { operation: step.operation, route: route.id },
      "Adding step to route",
    );
    route.steps.push(step);
    return this.withType<Current>();
  }

  /**
   * Process the data with a custom function.
   *
   * @template Return The resulting type after processing (defaults to Current if not specified)
   * @param processor A function that transforms the current exchange to a new exchange with the Return
   * @returns A RouteBuilder with the new type Return
   * @example
   * // Transform string data to number
   * .process<number>((exchange) => {
   *   return { ...exchange, body: parseInt(exchange.body) };
   * })
   */
  process<Return = Current>(
    processor:
      | Processor<Current, Return>
      | ((
          exchange: Exchange<Current, Headers>,
        ) => Promise<Exchange<Return>> | Exchange<Return>),
  ): RouteBuilder<Return, Headers> {
    this.addStep(
      new ProcessStep<Current, Return>(
        processor as
          | Processor<Current, Return>
          | CallableProcessor<Current, Return>,
      ),
    );
    return this.withType<Return>();
  }

  /**
   * Send the processed data to a destination.
   * If the destination returns undefined, the exchange continues unchanged.
   * If the destination returns a value, the exchange body is replaced with that value.
   *
   * @template R The result type returned by the destination
   * @param destination A function or adapter that sends the data
   * @returns A RouteBuilder with the result type
   * @example
   * // Send to a destination that returns void (no body change)
   * .to(async ({ body }) => {
   *   await db.users.insert(body);
   * })
   *
   * // Send and replace body with result
   * .to(http({ url: 'https://api.example.com/transform' }))
   * // Body becomes HttpResult
   */
  to<R = void>(
    destination:
      | Destination<Current, R>
      | ((exchange: Exchange<Current, Headers>) => Promise<R> | R),
  ): RouteBuilder<R, Headers> {
    const route = this.requireSource();
    logger.trace({ route: route.id }, "Adding destination step to route");
    route.steps.push(
      new ToStep<Current, R>(
        destination as
          | Destination<Current, R>
          | CallableDestination<Current, R>,
      ),
    );
    return this.withType<R>();
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
  ): RouteBuilder<ItemType, Headers> {
    const route = this.requireSource();
    logger.trace({ route: route.id }, "Adding split step to route");

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

      route.steps.push(new SplitStep<Current, ItemType>(defaultSplitter));
    } else {
      route.steps.push(new SplitStep<Current, ItemType>(splitter));
    }

    return this.withType<ItemType>();
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
  ): RouteBuilder<ResultType, Headers> {
    if (!aggregator) {
      // Use default aggregator which collects bodies into an array
      this.addStep(
        new AggregateStep<Current, ResultType>(
          defaultAggregate as CallableAggregator<Current, ResultType>,
        ),
      );
    } else {
      this.addStep(new AggregateStep<Current, ResultType>(aggregator));
    }
    return this.withType<ResultType>();
  }

  /**
   * Transform the current data to a new type using a transformer function.
   * Unlike process, this operates only on the body of the exchange, not the entire exchange.
   *
   * @template Return The resulting type after transformation
   * @param transformer A function that transforms the current body to a new body of type Return
   * @returns A RouteBuilder with the new type Return
   * @example
   * // Transform a string to an object
   * .transform<{ value: string }>((str) => ({ value: str }))
   */
  transform<Return>(
    transformer:
      | Transformer<Current, Return>
      | CallableTransformer<Current, Return>,
  ): RouteBuilder<Return, Headers> {
    this.addStep(new TransformStep<Current, Return>(transformer));
    return this.withType<Return>();
  }

  /**
   * Set or override a header on the current exchange.
   * The body type remains unchanged.
   *
   * @param key Header key to set
   * @param valueOrFn A static value or a function returning the value from exchange data
   * @returns A RouteBuilder with the same type
   * @example
   * // Static value
   * .header('x-env', 'prod')
   *
   * // Derived from body
   * .header('user.id', (exchange) => exchange.body.id)
   *
   * // Derived from headers
   * .header('correlation', (exchange) => exchange.headers['x-request-id'])
   */
  header<K extends string>(
    key: K,
    valueOrFn:
      | HeaderValue
      | ((
          exchange: Exchange<Current, Headers>,
        ) => HeaderValue | Promise<HeaderValue>),
  ): RouteBuilder<Current, Headers & Record<K, HeaderValue>> {
    this.addStep(
      new HeaderStep<Current>(
        key,
        valueOrFn as
          | HeaderValue
          | ((
              exchange: Exchange<Current>,
            ) => HeaderValue | Promise<HeaderValue>),
      ),
    );
    return this.withType<Current, Headers & Record<K, HeaderValue>>();
  }

  /**
   * Map fields from the current data to create a new object of a specified type.
   * This is a specialized transformer that creates a new object by mapping fields
   * from the source object.
   *
   * @template Return The resulting type after mapping
   * @param fieldMappings An object where keys are field names in the output type and values are
   *                      functions that extract the corresponding values from the source
   * @returns A RouteBuilder with the new type Return
   * @example
   * // Map from API response to database model
   * .map<DbUser>({
   *   id: (apiUser) => apiUser.userId,
   *   name: (apiUser) => apiUser.fullName,
   *   email: (apiUser) => apiUser.emailAddress
   * })
   */
  map<Return>(
    fieldMappings: Record<keyof Return, (src: Current) => Return[keyof Return]>,
  ): RouteBuilder<Return, Headers> {
    // Create a transformer function from the field mappings
    const transformer: CallableTransformer<Current, Return> = (
      message: Current,
    ): Return => {
      const result = {} as Return;

      for (const [targetField, mapperFn] of Object.entries(fieldMappings) as [
        keyof Return,
        (src: Current) => Return[keyof Return],
      ][]) {
        result[targetField as keyof Return] = mapperFn(message);
      }

      return result;
    };

    // Use the transform method with our created transformer
    return this.transform<Return>(transformer);
  }

  /**
   * Execute a side effect without changing the data.
   * This is useful for logging, metrics, or other operations that don't modify the data.
   * The type remains the same after tapping.
   * Return values are ignored.
   *
   * @param destination A destination adapter or function for side effects
   * @returns A RouteBuilder with the same type
   * @example
   * // Log the current data
   * .tap((exchange) => console.log('Processing:', exchange.body))
   *
   * // Send metrics
   * .tap((exchange) => {
   *   metrics.increment('items_processed');
   *   metrics.gauge('item_size', JSON.stringify(exchange.body).length);
   * })
   */
  tap(
    destination:
      | Destination<Current, unknown>
      | ((exchange: Exchange<Current, Headers>) => Promise<unknown> | unknown),
  ): RouteBuilder<Current, Headers> {
    this.addStep(
      new TapStep<Current>(
        destination as
          | Destination<Current, unknown>
          | CallableDestination<Current, unknown>,
      ),
    );
    return this.withType<Current>();
  }

  /**
   * Filter data based on a predicate function.
   * Exchanges that don't match the predicate will be dropped.
   * The predicate receives the full Exchange object, allowing filtering based on
   * headers, body, or other exchange properties.
   *
   * @param filter A function that receives the Exchange and returns true to keep it, false to drop it
   * @returns A RouteBuilder with the same type
   * @example
   * // Filter based on body value
   * .filter((exchange) => exchange.body > 10)
   *
   * // Filter based on body properties
   * .filter((exchange) => exchange.body.age >= 18 && exchange.body.status === 'active')
   *
   * // Filter based on headers
   * .filter((exchange) => exchange.headers['x-priority'] === 'high')
   */
  filter(
    filter:
      | Filter<Current>
      | ((exchange: Exchange<Current, Headers>) => Promise<boolean> | boolean),
  ): RouteBuilder<Current, Headers> {
    this.addStep(
      new FilterStep<Current>(
        filter as Filter<Current> | CallableFilter<Current>,
      ),
    );
    return this.withType<Current>();
  }

  /**
   * Validate data against a schema.
   * Throws an error if validation fails.
   *
   * @param schema A JSON schema to validate against
   * @returns A RouteBuilder with the same type
   * @example
   * // Validate with JSON schema
   * .validate({
   *   type: 'object',
   *   properties: {
   *     name: { type: 'string' },
   *     age: { type: 'number', minimum: 0 }
   *   },
   *   required: ['name', 'age']
   * })
   */
  validate<S extends StandardSchemaV1>(
    schema: S,
  ): RouteBuilder<StandardSchemaV1.InferOutput<S>, Headers> {
    this.addStep(new ValidateStep(schema));
    return this.withType<StandardSchemaV1.InferOutput<S>>();
  }

  /**
   * Enrich the current data with additional information from a destination.
   * By default, the result is merged into the exchange body.
   * Uses the same Destination adapters as .to() but with a merge-by-default aggregator.
   *
   * @template R The resulting type after enrichment (defaults to Current if not specified)
   * @param destination A destination adapter or function that returns enrichment data
   * @param aggregator Optional function to control how data is combined
   * @returns A RouteBuilder with the combined type
   * @example
   * // Add user details from an API (default merge behavior)
   * .enrich(http({
   *   url: (ex) => `https://api.example.com/users/${ex.body.userId}`
   * }))
   *
   * // Custom aggregation strategy
   * .enrich(
   *   http({ url: 'https://api.example.com/data' }),
   *   (original, result) => ({
   *     ...original,
   *     body: { ...original.body, fetchedData: result.body }
   *   })
   * )
   */
  enrich<R>(
    destination:
      | Destination<Current, R>
      | ((exchange: Exchange<Current, Headers>) => Promise<R> | R),
  ): RouteBuilder<Current & R, Headers>;
  enrich<
    R = Current,
    A extends
      | DestinationAggregator<Current, unknown>
      | (DestinationAggregator<unknown, unknown> & {
          [ENRICH_MERGE_TYPE]?: EnrichMergeShape;
        })
      | undefined = DestinationAggregator<Current, unknown> | undefined,
  >(
    destination:
      | Destination<Current, Partial<R>>
      | ((
          exchange: Exchange<Current, Headers>,
        ) => Promise<Partial<R>> | Partial<R>),
    aggregator: A,
  ): RouteBuilder<
    A extends { [ENRICH_MERGE_TYPE]: infer M } ? Current & M : R,
    Headers
  >;
  enrich<
    R = Current,
    A extends
      | DestinationAggregator<Current, unknown>
      | (DestinationAggregator<unknown, unknown> & {
          [ENRICH_MERGE_TYPE]?: EnrichMergeShape;
        })
      | undefined = DestinationAggregator<Current, unknown> | undefined,
  >(
    destination:
      | Destination<Current, Partial<R>>
      | ((
          exchange: Exchange<Current, Headers>,
        ) => Promise<Partial<R>> | Partial<R>),
    aggregator?: A,
  ): RouteBuilder<
    A extends { [ENRICH_MERGE_TYPE]: infer M } ? Current & M : R,
    Headers
  > {
    this.addStep(
      new EnrichStep<Current, Partial<R>>(
        destination as
          | Destination<Current, Partial<R>>
          | CallableDestination<Current, Partial<R>>,
        aggregator,
      ),
    );
    return this.withType<
      A extends { [ENRICH_MERGE_TYPE]: infer M } ? Current & M : R
    >();
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
   * const ctx = await new ContextBuilder().routes(definitions).build();
   * await ctx.start();
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
