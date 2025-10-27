import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type RouteDefinition } from "./route.ts";
import {
  CraftContext,
  type StoreRegistry,
  type CraftConfig,
} from "./context.ts";
import { error as rcError } from "./error.ts";
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
import { type Exchange } from "./exchange.ts";
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
} from "./operations/aggregate.ts";
import {
  type Transformer,
  type CallableTransformer,
  TransformStep,
} from "./operations/transform.ts";
import { type Tap, type CallableTap, TapStep } from "./operations/tap.ts";
import {
  type CallableFilter,
  type Filter,
  FilterStep,
} from "./operations/filter.ts";
import { ValidateStep } from "./operations/validate.ts";
import {
  type EnrichAggregator,
  EnrichStep,
  type Enricher,
  type CallableEnricher,
} from "./operations/enrich.ts";
import { HeaderStep } from "./operations/header.ts";
import { type HeaderValue } from "./exchange.ts";
// Binder mechanism removed

/**
 * Builder for creating a RouteCraft context with routes and configuration.
 *
 * This builder provides a fluent API for configuring and creating a CraftContext
 * with routes, startup/shutdown handlers, and initial store values.
 *
 * @example
 * ```typescript
 * // Create a context with routes and handlers
 * const context = new ContextBuilder()
 *   .with({ routes: [] })
 *   .on('contextStarting', ({ ts }) => console.log('Starting at', ts))
 *   .store('routecraft.adapter.channel.store', new Map())
 *   .routes(routes1)
 *   .routes([routes2, routes3])
 *
 * // Start the context to begin processing
 * await context.start();
 * ```
 */
export class ContextBuilder {
  protected config?: CraftConfig;
  protected definitions: RouteDefinition[] = [];
  protected initialStores = new Map<
    keyof StoreRegistry,
    StoreRegistry[keyof StoreRegistry]
  >();
  protected eventHandlers = new Map<EventName, Set<EventHandler<EventName>>>();
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
    if (Array.isArray(routes)) {
      // Handle array of RouteDefinitions or RouteBuilders
      routes.forEach((route) => {
        if (route instanceof RouteBuilder) {
          this.definitions.push(...route.build());
        } else {
          this.definitions.push(route);
        }
      });
    } else if (routes instanceof RouteBuilder) {
      // Handle single RouteBuilder
      this.definitions.push(...routes.build());
    } else {
      // Handle single RouteDefinition
      this.definitions.push(routes);
    }
    return this;
  }

  /**
   * Build and return a configured CraftContext instance.
   *
   * This finalizes the configuration and creates a ready-to-use context
   * with all the configured routes, handlers, and store values.
   *
   * @returns A new CraftContext instance
   */
  build(): CraftContext {
    const ctx = new CraftContext(this.config);

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
export class RouteBuilder<Current = unknown> {
  protected currentRoute?: RouteDefinition;
  protected routes: RouteDefinition[] = [];

  // Pending options set via .id() / .batch() before .from()
  protected pendingOptions?:
    | {
        id?: string;
        consumer?: {
          type: ConsumerType<Consumer>;
          options?: unknown;
        };
      }
    | undefined;

  constructor() {}

  /**
   * Internal method to create a new RouteBuilder with an updated type parameter.
   * This is used to propagate type information through the method chain.
   *
   * @template T The new type to use for the RouteBuilder
   * @returns A new RouteBuilder instance with the updated type
   * @private
   */
  private withType<T>(): RouteBuilder<T> {
    // This cast is necessary but safe because we're not changing the instance,
    // just the type parameter
    return this as unknown as RouteBuilder<T>;
  }

  /**
   * Set the route id for the next route to be created.
   * This stages the id and does not affect the current route if one exists.
   */
  id(id: string): this {
    this.pendingOptions = { ...(this.pendingOptions ?? {}), id };
    logger.debug(`Staging route id "${id}" for next route`);
    return this;
  }

  /**
   * Configure batch processing for the next route to be created.
   * This stages the batch consumer and does not affect the current route if one exists.
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
    logger.debug("Staging batch processing for next route");
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
  from<T>(source: Source<T> | CallableSource<T>): RouteBuilder<T> {
    const id = this.pendingOptions?.id ?? crypto.randomUUID().toString();
    const consumer = this.pendingOptions?.consumer ?? {
      type: SimpleConsumer as unknown as ConsumerType<Consumer>,
      options: undefined,
    };

    logger.debug(`Creating route definition with id "${id}"`);

    this.currentRoute = {
      id,
      source: typeof source === "function" ? { subscribe: source } : source,
      steps: [],
      consumer: {
        type: consumer.type,
        options: consumer.options ?? undefined,
      },
    };

    // Clear staged options once used
    this.pendingOptions = undefined;

    this.routes.push(this.currentRoute);
    return this.withType<T>();
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
  private addStep<T extends Adapter>(step: Step<T>): RouteBuilder<Current> {
    const route = this.requireSource();
    logger.debug(`Adding ${step.operation} step to route "${route.id}"`);
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
    processor: Processor<Current, Return> | CallableProcessor<Current, Return>,
  ): RouteBuilder<Return> {
    this.addStep(new ProcessStep<Current, Return>(processor));
    return this.withType<Return>();
  }

  /**
   * Send the processed data to a destination.
   * This is typically the final step in a route.
   * The type remains the same after this operation.
   *
   * @param destination A function or adapter that consumes the data
   * @returns A RouteBuilder with the same type
   * @example
   * // Send data to a database
   * .to(async ({ body }) => {
   *   await db.users.insert(body);
   * })
   *
   * // Send to a predefined destination
   * .to(kafkaProducer({ topic: 'processed-data' }))
   */
  to(
    destination: Destination<Current> | CallableDestination<Current>,
  ): RouteBuilder<Current> {
    const route = this.requireSource();
    logger.debug(`Adding destination step to route "${route.id}"`);
    route.steps.push(new ToStep<Current>(destination));
    return this.withType<Current>();
  }

  /**
   * Split an array into individual items for processing.
   * If no splitter is provided and the current data is an array, it will automatically
   * split the array into individual items.
   *
   * @template ItemType The type of items in the array (inferred from array if not specified)
   * @param splitter Optional function to control how the array is split
   * @returns A RouteBuilder with the item type
   * @example
   * // Automatically split an array of numbers
   * .from<number[]>(source)
   * .split() // ItemType is inferred as number
   *
   * // Explicitly specify the item type
   * .from(source)
   * .split<User>((exchange) => {
   *   return exchange.body.users.map(user => ({ ...exchange, body: user }));
   * })
   */
  split<ItemType = Current extends Array<infer U> ? U : never>(
    splitter?:
      | Splitter<Current, ItemType>
      | CallableSplitter<Current, ItemType>,
  ): RouteBuilder<ItemType> {
    const route = this.requireSource();
    logger.debug(`Adding split step to route "${route.id}"`);

    // If no splitter is provided and Current is an array, use default array splitter
    if (!splitter) {
      // Create a default array splitter
      const defaultSplitter: CallableSplitter<Current, ItemType> = (
        exchange,
      ) => {
        // Check if the body is an array
        if (!Array.isArray(exchange.body)) {
          throw rcError("RC2001", undefined, {
            message: "Default splitter can only be used with arrays",
            suggestion:
              "Provide a custom splitter or ensure the input is an array",
          });
        }

        // Split the array into individual items
        return exchange.body.map((item) => ({
          ...exchange,
          body: item,
        })) as Exchange<ItemType>[];
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
   *
   * @template ResultType The resulting type after aggregation
   * @param aggregator A function that combines multiple items into a single result
   * @returns A RouteBuilder with the new aggregated type
   * @example
   * // Aggregate an array of numbers into a sum
   * .split() // Working with individual numbers
   * .process((exchange) => ({ ...exchange, body: exchange.body * 2 })) // Double each number
   * .aggregate<number>((exchanges) => {
   *   const sum = exchanges.reduce((acc, ex) => acc + ex.body, 0);
   *   return { body: sum, headers: exchanges[0].headers };
   * })
   */
  aggregate<ResultType>(
    aggregator:
      | Aggregator<Current, ResultType>
      | CallableAggregator<Current, ResultType>,
  ): RouteBuilder<ResultType> {
    this.addStep(new AggregateStep<Current, ResultType>(aggregator));
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
  ): RouteBuilder<Return> {
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
  header(
    key: string,
    valueOrFn:
      | HeaderValue
      | ((exchange: Exchange<Current>) => HeaderValue | Promise<HeaderValue>),
  ): RouteBuilder<Current> {
    this.addStep(new HeaderStep<Current>(key, valueOrFn));
    return this.withType<Current>();
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
  ): RouteBuilder<Return> {
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
   *
   * @param tap A function that performs a side effect
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
  tap(tap: Tap<Current> | CallableTap<Current>): RouteBuilder<Current> {
    this.addStep(new TapStep<Current>(tap));
    return this.withType<Current>();
  }

  /**
   * Filter data based on a predicate function.
   * Exchanges that don't match the predicate will be dropped.
   *
   * @param filter A function that returns true to keep the exchange, false to drop it
   * @returns A RouteBuilder with the same type
   * @example
   * // Keep only numbers greater than 10
   * .filter((num) => num > 10)
   *
   * // Filter based on a complex condition
   * .filter((user) => user.age >= 18 && user.status === 'active')
   */
  filter(
    filter: Filter<Current> | CallableFilter<Current>,
  ): RouteBuilder<Current> {
    this.addStep(new FilterStep<Current>(filter));
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
  validate(schema: StandardSchemaV1): RouteBuilder<Current> {
    this.addStep(new ValidateStep(schema));
    return this.withType<Current>();
  }

  /**
   * Enrich the current data with additional information.
   * This is useful for adding context or fetching related data.
   *
   * @template R The resulting type after enrichment (defaults to Current if not specified)
   * @param enricher Function that returns additional data to be merged
   * @param aggregator Optional function to control how data is combined
   * @returns A RouteBuilder with the combined type
   * @example
   * // Add user details from an API
   * .enrich<User & { profile: Profile }>(async (user) => {
   *   const details = await fetchUserDetails(user.id);
   *   return details;
   * })
   *
   * // Custom aggregation strategy
   * .enrich<CustomType>(
   *   async (exchange) => ({ extraData: "value" }),
   *   (original, enrichmentData) => ({
   *     ...original,
   *     body: customMergeFunction(original.body, enrichmentData)
   *   })
   * )
   */
  enrich<R = Current>(
    enricher:
      | Enricher<Current, Partial<R>>
      | CallableEnricher<Current, Partial<R>>,
    aggregator?: EnrichAggregator<Current, Partial<R>>,
  ): RouteBuilder<R> {
    this.addStep(new EnrichStep(enricher, aggregator));
    return this.withType<R>();
  }

  /**
   * Finalize the route definition and return it.
   * This method should be called after all steps have been defined.
   *
   * @returns An array of RouteDefinition objects
   * @example
   * // Define a complete route and build it
   * const route = craft()
   *   .from<string[]>(source)
   *   .split()
   *   .process((exchange) => ({ ...exchange, body: exchange.body.toUpperCase() }))
   *   .to(destination)
   *
   * // Add the route to a context
   * context()
   *   .routes(route)
   *   .build();
   */
  build(): RouteDefinition[] {
    logger.debug(`Building ${this.routes.length} routes`);
    return this.routes;
  }
}
