import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { BRAND, setBrand } from "./brand.ts";
import {
  StepBuilderBase,
  type BuilderState,
  type SetBody,
} from "./step-builder-base.ts";
import {
  type RouteDefinition,
  type ErrorHandler,
  type RouteDiscovery,
  type RouteSchemas,
  type Tag,
  buildCacheCheckStep,
  buildCacheStoreStep,
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
import { type Source, type SourceLike, toSource } from "./operations/from.ts";
import {
  type Adapter,
  type Step,
  type Consumer,
  type ConsumerType,
} from "./types.ts";
import { OperationType } from "./exchange.ts";
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
import { ValidateStep } from "./operations/validate.ts";
import { authorize, type AuthorizeOptions } from "./auth/authorize.ts";
import {
  type CacheOptions,
  resolveCacheOptions,
  type ResolvedCacheOptions,
} from "./operations/cache-wrapper.ts";
import {
  type RetryOptions,
  type ResolvedRetryOptions,
  resolveRetryOptions,
} from "./operations/retry-wrapper.ts";
import { type ResolvedTimeoutOptions } from "./operations/timeout-wrapper.ts";

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
 * await client.sendDirect('my-endpoint', { data: 'hello' });
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

  constructor() {}

  /**
   * Configure the context with the provided config object.
   *
   * Merge semantics across multiple `with()` calls are not symmetric:
   *
   * - `plugins` accumulates: every `with()` call appends its `plugins[]`
   *   to a builder-side list. Builder stores and event handlers also
   *   accumulate.
   * - Every other key (`store`'s value map aside, plus `cron`, `direct`,
   *   `http`, `mail`, `telemetry`, and any ecosystem-augmented keys such
   *   as `llm`, `mcp`) is last-writer-wins: a second `with()` replaces
   *   the previously stored config object, and only the most recent
   *   non-`plugins` keys reach the constructor.
   *
   * If you need to combine non-`plugins` keys across sources, merge them
   * into a single object before calling `with()` (or call `with()` once).
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

    // Accumulate plugins across multiple with() calls. The CraftContext
    // constructor handles config.cron, config.direct, config.http,
    // config.mail, and config.telemetry from `this.config`; we don't
    // duplicate those conversions here. Only `plugins` needs to be
    // accumulated because successive with() calls overwrite this.config.
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
      | AnyRouteBuilder[]
      | RouteDefinition
      | AnyRouteBuilder,
  ): this {
    const addOne = (route: RouteDefinition | AnyRouteBuilder): void => {
      // Structural check, matching `AnyRouteBuilder` (and the duck-typing
      // promise above): anything with a callable `.build()` is treated as
      // a builder. The brand check alone would misclassify unbranded
      // structural builders as RouteDefinitions; RouteDefinition has no
      // `build`, so the duck-type cannot misfire the other way.
      if (typeof (route as Partial<AnyRouteBuilder>).build === "function") {
        this.definitions.push(...(route as AnyRouteBuilder).build());
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
   * await client.sendDirect('greet', { name: 'World' });
   * ```
   */
  async build(): Promise<{ context: CraftContext; client: CraftClient }> {
    // The builder accumulates plugins across multiple with() calls into
    // `this.plugins`; replace `config.plugins` with the accumulated list so
    // the constructor sees the union, not just the last with()'s plugins.
    // Config keys like `telemetry`, `mail`, and registered config appliers
    // (e.g. `llm`, `mcp`) are converted into plugins inside the constructor
    // and run before user `plugins[]`; see CraftContext.constructor.
    const mergedConfig: CraftConfig = {
      ...this.config,
      plugins: this.plugins,
    };
    const ctx = new CraftContext(mergedConfig);

    // Add stores from builder (config stores already added in constructor)
    for (const [key, value] of this.initialStores) {
      if (!this.config?.store?.has(key)) {
        ctx.setStore(key, value);
      }
    }

    // Attach event handlers from builder. `config.on` handlers are already
    // registered by the constructor, but the builder's `eventHandlers` map
    // also contains them (with the same handler references), so the
    // CraftContext's Set-based registry deduplicates.
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

    return { context: ctx, client: new CraftClient(ctx) };
  }
}

/**
 * Any route builder, regardless of its tracked {@link BuilderState}.
 *
 * `RouteBuilder<S>` is invariant in its state bag (the body type appears in
 * both parameter and return positions), so a fully chained
 * `RouteBuilder<{ body: X }>` is not assignable to
 * `RouteBuilder<BuilderState>`. Positions that accept "some finished route
 * builder" (`ContextBuilder.routes`, the CLI loader, test harnesses) only
 * ever call `.build()`, which does not involve the bag at all, so this
 * minimal structural alias is the correct parameter type for them.
 */
export type AnyRouteBuilder = Pick<RouteBuilder, "build">;

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
 * @template S The {@link BuilderState} bag tracking the data flowing through the route
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

/**
 * @internal
 *
 * Verifies a finalised route honours the route-scope `.cache()` contract.
 *
 * Route-scope `.cache()` caches a single terminal body per source message.
 * A bare `.split()` produces N terminal exchanges with no fold-back, so
 * there is no single value to cache. A `.split()` that is balanced by a
 * matching `.aggregate()` collapses the children back into one terminal
 * body, which is cacheable.
 *
 * The check counts nesting depth across the step list: every `split`
 * increments, every `aggregate` decrements. A non-zero depth at the end
 * of the route means at least one `split` was not aggregated, so the
 * route is rejected with `RC5003`.
 *
 * Step-scope `.cache()` is unaffected; it wraps a single inner step and
 * never participates in this check.
 */
function assertRouteScopeCacheCompatibility(route: RouteDefinition): void {
  const hasRouteScopeCache = route.postParseFilters.some(
    (f) => f.label === "cache-check",
  );
  if (!hasRouteScopeCache) return;

  let depth = 0;
  for (const step of route.steps) {
    if (step.operation === OperationType.SPLIT) {
      depth++;
    } else if (step.operation === OperationType.AGGREGATE && depth > 0) {
      depth--;
    }
  }

  if (depth > 0) {
    throw rcError("RC5003", undefined, {
      message:
        `Route "${route.id}" has route-scope .cache() and an unbalanced .split() ` +
        `(no matching .aggregate()). A fire-and-forget split produces multiple ` +
        `terminal exchanges, so there is no single body to cache. ` +
        `Add an .aggregate() to fold the children back into one terminal ` +
        `value, or use step-scope .cache() to wrap the expensive operation.`,
    });
  }
}

/**
 * Route-scope staging methods shared by both pre-`.from()` surfaces
 * ({@link PreFromBuilder} and {@link PreFromTypedBuilder}). Methods return
 * `this` so the chain keeps whichever surface it is on: staging calls after
 * a typed `.input()` do not lose the staged body type.
 *
 * @template S - The {@link BuilderState} bag carried into the next route
 */
export interface PreFromStaging<S extends BuilderState = BuilderState> {
  /** Set the route id for the next route. See {@link RouteBuilder.id}. */
  id(id: string): this;
  /** Set a human-readable title for the next route. See {@link RouteBuilder.title}. */
  title(value: string): this;
  /** Set a human-readable description for the next route. See {@link RouteBuilder.description}. */
  description(value: string): this;
  /**
   * Declare input schemas for the next route and retype the chain. When a
   * body schema is given (bare, or as `{ body }`), the schema's inferred
   * output type becomes the body type the following `.from(source)` opens
   * the pipeline with, so no duplicated `.from<T>()` generic is needed.
   * See {@link RouteBuilder.input}.
   */
  input<Schema extends StandardSchemaV1>(
    schemas: Schema | (RouteSchemas & { body: Schema }),
  ): PreFromTypedBuilder<SetBody<S, StandardSchemaV1.InferOutput<Schema>>>;
  /** Declare input schemas (no body schema, so no retyping). See {@link RouteBuilder.input}. */
  input(schemas: RouteSchemas): this;
  /** Declare output schemas for the next route. See {@link RouteBuilder.output}. */
  output(schemas: RouteSchemas | StandardSchemaV1): this;
  /** Tag the next route. See {@link RouteBuilder.tag}. */
  tag(value: Tag | Tag[]): this;
  /** Configure batch processing for the next route. See {@link RouteBuilder.batch}. */
  batch(options?: { size?: number; flushIntervalMs?: number }): this;
  /**
   * Attach a ROUTE-SCOPE error handler (catch-all) to the next route. The
   * step-scope variant lives on the post-`.from()` builder; position picks
   * the mode. See {@link RouteBuilder.error}.
   */
  error(handler: ErrorHandler): this;
  /**
   * Configure ROUTE-SCOPE caching for the next route (whole-pipeline
   * memoisation). The step-scope variant lives on the post-`.from()`
   * builder. See {@link RouteBuilder.cache}.
   */
  cache(options?: CacheOptions<unknown>): this;
  /**
   * Configure a ROUTE-SCOPE retry for the next route (re-run the whole
   * pipeline on failure, chain position 7). The step-scope variant
   * lives on the post-`.from()` builder. See {@link RouteBuilder.retry}.
   */
  retry(options?: RetryOptions): this;
  /**
   * Configure a ROUTE-SCOPE timeout for the next route (per-attempt
   * deadline over the whole pipeline, chain position 8). The
   * step-scope variant lives on the post-`.from()` builder. See
   * {@link RouteBuilder.timeout}.
   */
  timeout(timeoutMs: number): this;
  /** Declare an authorization requirement on the next route. See {@link RouteBuilder.authorize}. */
  authorize(options?: AuthorizeOptions): this;
  /** Finalize and return the route definition(s). See {@link RouteBuilder.build}. */
  build: RouteBuilder<S>["build"];
}

/**
 * The route builder BEFORE `.from()`: only route-scope staging is reachable.
 *
 * `craft()` returns this type, and every staging method on the full
 * {@link RouteBuilder} (`.id()`, `.title()`, ...) flips the chain back into
 * it, so calling a pipeline operation (`.to()`, `.transform()`, `.split()`,
 * ...) before `.from()` is a COMPILE error rather than only the runtime
 * RC2001/RC2002 it has always been. The runtime guards remain for plain
 * JavaScript users; this interface is the type-level mirror of the same
 * contract.
 *
 * There is no separate runtime class: the value behind this type is the one
 * `RouteBuilder` instance, re-surfaced. `.from()` opens the route and hands
 * back the full pipeline surface. A `.input()` call with a body schema
 * flips the chain into {@link PreFromTypedBuilder} instead, which seeds
 * `.from()` with the schema's inferred body type.
 *
 * @template S - The {@link BuilderState} bag carried into the next route
 */
export interface PreFromBuilder<
  S extends BuilderState = BuilderState,
> extends PreFromStaging<S> {
  /**
   * Open the route: define its source(s) and enter the pipeline surface.
   * Derived from the class via an indexed-access type so the (ordering
   * sensitive) overload set is defined exactly once, on
   * {@link RouteBuilder.from}; a future overload change cannot diverge
   * between the pre-`from` and post-`from` surfaces.
   */
  from: RouteBuilder<S>["from"];
}

/**
 * The pre-`.from()` surface after `.input()` declared a body schema: the
 * schema's inferred output type is staged in `S`, and `.from(source)` opens
 * the pipeline with that body type instead of inferring (typically
 * `unknown`) from the source adapter. The engine validates every inbound
 * body against the schema before the first step runs, which is what makes
 * seeding the static type from the schema sound.
 *
 * An explicit `.from<T>(source)` generic still overrides the staged type.
 *
 * @template S - The {@link BuilderState} bag, body already set from the schema
 */
export interface PreFromTypedBuilder<
  S extends BuilderState = BuilderState,
> extends PreFromStaging<S> {
  /**
   * Open the route with the body type staged by `.input()`. Accepts one or
   * more sources; multi-ingress routes require the `.input()` body schema
   * anyway (RC2001), so every channel validates to this one type.
   */
  from(
    ...sources: [SourceLike<unknown>, ...Array<SourceLike<unknown>>]
  ): RouteBuilder<S>;
  /**
   * Open the route with an explicit body type, overriding the staged one.
   */
  from<T>(
    ...sources: [SourceLike<unknown>, ...Array<SourceLike<unknown>>]
  ): RouteBuilder<SetBody<S, T>>;
}

export class RouteBuilder<
  S extends BuilderState = BuilderState,
> extends StepBuilderBase<S> {
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
        cacheConfig?: ResolvedCacheOptions;
        retryConfig?: ResolvedRetryOptions;
        timeoutConfig?: ResolvedTimeoutOptions;
        discovery?: RouteDiscovery;
        authorizers?: AuthorizeOptions[];
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
   * craft().id('ingest-api').from(http({ path: '/ingest', method: 'POST' })).to(log()).build();
   * ```
   */
  id(id: string): PreFromBuilder {
    this.assertNoPendingWrappers("id");
    this.pendingOptions = { ...(this.pendingOptions ?? {}), id };
    logger.trace({ route: id }, "Staging route id for next route");
    return this.prelude();
  }

  /**
   * Set a human-readable title for the next route. Mirrored into the
   * direct / mcp registries so discovery consumers (agents, docs) can
   * display it alongside the id.
   */
  title(value: string): PreFromBuilder {
    this.mergeDiscovery({ title: value });
    return this.prelude();
  }

  /**
   * Set a human-readable description for the next route. Used by
   * discovery-aware adapters when exposing the route to external consumers
   * (agents, MCP clients).
   */
  description(value: string): PreFromBuilder {
    this.mergeDiscovery({ description: value });
    return this.prelude();
  }

  /**
   * Declare input schemas for the next route. The engine validates incoming
   * message bodies and headers against these schemas before any pipeline
   * step runs; a validation failure emits `exchange:dropped` and the
   * pipeline never sees the message. Accepts either a bundle
   * (`{ body, headers }`) or a bare Standard Schema as a body-only shorthand.
   *
   * When a body schema is given, the chain is retyped: the following
   * `.from(source)` opens the pipeline with the schema's inferred output
   * type, so the type does not have to be repeated as a `.from<T>()`
   * generic. An explicit `.from<T>()` still overrides the staged type.
   *
   * @example
   * ```typescript
   * craft()
   *   .id('lookup-user')
   *   .input({ body: UserQuerySchema })
   *   .from(direct())
   *   // the body is already typed as the schema output
   *   .transform((body) => findUser(body.userId))
   * ```
   */
  input<Schema extends StandardSchemaV1>(
    schemas: Schema | (RouteSchemas & { body: Schema }),
  ): PreFromTypedBuilder<SetBody<S, StandardSchemaV1.InferOutput<Schema>>>;
  input(schemas: RouteSchemas): PreFromBuilder;
  input(
    schemas: RouteSchemas | StandardSchemaV1,
  ): PreFromBuilder | PreFromTypedBuilder<SetBody<S, unknown>> {
    this.mergeDiscovery({ input: this.normalizeSchemas(schemas) });
    return this.prelude();
  }

  /**
   * Declare output schemas for the next route. The engine validates the
   * final exchange against these schemas before the primary destination
   * fires; a validation failure is routed to the error handler. Accepts
   * either a bundle (`{ body, headers }`) or a bare Standard Schema as a
   * body-only shorthand.
   */
  output(schemas: RouteSchemas | StandardSchemaV1): PreFromBuilder {
    this.mergeDiscovery({ output: this.normalizeSchemas(schemas) });
    return this.prelude();
  }

  /**
   * Tag the next route. Accepts a single tag or an array; multiple
   * `.tag()` calls before `.from()` accumulate (deduplicated, insertion
   * order preserved). Empty strings are rejected.
   *
   * Tags drive selectors like `tools({ tagged: "read-only" })` in
   * `@routecraft/ai`; use the `KnownTag` literals (`"read-only"`,
   * `"destructive"`, `"idempotent"`, `"open-world"`) where they fit, and any
   * string otherwise. On a route exposed via `.from(mcp())`, these four tags
   * also derive the MCP tool annotation hints (`readOnlyHint`,
   * `destructiveHint`, `idempotentHint`, `openWorldHint`), so the same fact is
   * declared once; explicit `annotations` on `mcp()` still override per-key.
   */
  tag(value: Tag | Tag[]): PreFromBuilder {
    const incoming = (Array.isArray(value) ? value : [value]).map((t) => {
      if (typeof t !== "string" || t.trim() === "") {
        throw rcError("RC2001", undefined, {
          message: `Route .tag() value must be a non-empty string.`,
        });
      }
      return t.trim();
    });
    const existing = this.pendingOptions?.discovery?.tags ?? [];
    const merged = [...existing];
    for (const t of incoming) if (!merged.includes(t)) merged.push(t);
    this.mergeDiscovery({ tags: merged });
    return this.prelude();
  }

  private mergeDiscovery(partial: Partial<RouteDiscovery>): void {
    const existing = this.pendingOptions?.discovery;
    if (partial.input !== undefined && existing?.input !== undefined) {
      throw rcError("RC2001", undefined, {
        message: `Route metadata already declared: .input() can only be called once per route.`,
      });
    }
    if (partial.output !== undefined && existing?.output !== undefined) {
      throw rcError("RC2001", undefined, {
        message: `Route metadata already declared: .output() can only be called once per route.`,
      });
    }
    this.pendingOptions = {
      ...(this.pendingOptions ?? {}),
      discovery: { ...(existing ?? {}), ...partial },
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
  batch(options?: { size?: number; flushIntervalMs?: number }): PreFromBuilder {
    const mapped = {
      size: options?.size,
      time: options?.flushIntervalMs,
    };
    this.pendingOptions = {
      ...(this.pendingOptions ?? {}),
      consumer: {
        type: BatchConsumer,
        options: mapped,
      },
    };
    logger.trace("Staging batch processing for next route");
    return this.prelude();
  }

  /**
   * Attach an error handler. Dual-mode based on position relative to
   * `.from()`:
   *
   * - **Before `.from()`** (route scope): stages a catch-all for the
   *   route's pipeline. When any step throws an unhandled error the
   *   handler runs and the pipeline does NOT resume; the handler's
   *   return value becomes the route's final exchange body.
   * - **After `.from()`** (step scope): wraps the immediately next
   *   step. When that step throws the handler runs, its return value
   *   replaces `exchange.body`, and the pipeline continues with the
   *   next step. Subsequent steps see the recovery as if nothing went
   *   wrong.
   *
   * The handler signature is identical in both positions
   * (`(error, exchange, forward) => unknown`). When a step-scope
   * handler itself throws, the wrapper rethrows so a route-scope
   * handler (when set) catches it; otherwise the default error path
   * fires (`route:*:error`, `context:error`, `exchange:failed`). The
   * route is NOT stopped.
   *
   * @param handler - Receives the error, the exchange at the point of
   *   failure, and a `forward` function to delegate to another route
   *   via the direct adapter.
   * @returns This builder for chaining
   *
   * @example Route-scope catch-all
   * ```ts
   * craft()
   *   .id('process-orders')
   *   .error((err, ex, forward) => forward('error-route', { reason: String(err) }))
   *   .from(timer({ intervalMs: 60000 }))
   *   .to(dangerousDestination)
   * ```
   *
   * @example Step-scope recovery (pipeline continues)
   * ```ts
   * craft()
   *   .id('resilient-pipeline')
   *   .from(timer({ intervalMs: 60000 }))
   *   .transform(prepareRequest)
   *   .error((err) => ({ fallback: true, reason: String(err) }))
   *   .to(http({ url: 'https://flaky.api/endpoint' }))
   *   .to(database())
   * ```
   *
   * wrapper pattern. See `.standards/resilience-wrappers.md`.
   */
  override error(handler: ErrorHandler): this {
    if (this.currentRoute === undefined || this.pendingOptions !== undefined) {
      // Pre-`.from()` for the FIRST route, OR staging for the NEXT
      // route in a chained `craft().id(a).from(...).to(...).id(b)
      // .error(h)...` pattern. In both cases `.error()` configures
      // route-scope behaviour for the route currently being staged
      // by `pendingOptions`. The base-class wrapper stack stays empty.
      this.pendingOptions = {
        ...(this.pendingOptions ?? {}),
        errorHandler: handler,
      };
      logger.trace("Staging route-scope error handler for next route");
      return this;
    }
    // Post-`.from()` on the current route: delegate to the base-class
    // step-scope path so the next pushed step is wrapped in
    // `ErrorWrapperStep`.
    return super.error(handler);
  }

  /**
   * Cache. Dual-mode:
   *
   * - **Before `.from()` (route scope):** the route looks up its
   *   provider before any pipeline step runs. On a hit, the entire
   *   pipeline is skipped and the cached body is returned to the
   *   source as the route's final exchange body. On a miss, the
   *   pipeline runs normally and the terminal body is stored for
   *   future hits. Side effects (e.g. `.to(destination)` calls) do
   *   NOT replay on a hit; the whole pipeline is bypassed.
   *
   * - **After `.from()` (step scope):** wraps the immediately-next
   *   step; see {@link StepBuilderBase.cache} for the step-scope
   *   contract.
   *
   * Routes with `.split()` are not supported at route scope (the
   * pipeline produces N terminals rather than one) and throw
   * `RC5003` at build time. Use step-scope `.cache()` to wrap the
   * expensive step inside such a route.
   *
   * @experimental
   */
  override cache(options: CacheOptions<S["body"]> = {}): this {
    if (this.currentRoute === undefined || this.pendingOptions !== undefined) {
      // Route scope: stage the resolved config onto pendingOptions so
      // the next `.from()` writes it into the new RouteDefinition.
      this.pendingOptions = {
        ...(this.pendingOptions ?? {}),
        cacheConfig: resolveCacheOptions(options as CacheOptions),
      };
      logger.trace("Staging route-scope cache config for next route");
      return this;
    }
    return super.cache(options);
  }

  /**
   * Timeout. Dual-mode:
   *
   * - **Before `.from()` (route scope):** bounds each run of the whole
   *   pipeline with a deadline at pre-from filter chain position 8
   *   (inside `.retry()`, so every attempt gets its own deadline). On
   *   expiry the pipeline throws `RC5011`, which a route-scope
   *   `.error()` handler catches like any other failure.
   *
   * - **After `.from()` (step scope):** wraps the immediately-next
   *   step; see {@link StepBuilderBase.timeout} for the step-scope
   *   contract.
   *
   * The bounded work is not cancelled on expiry (promises cannot be
   * cancelled); the timeout bounds how long the route waits, not the
   * work itself.
   */
  override timeout(timeoutMs: number): this {
    if (this.currentRoute === undefined || this.pendingOptions !== undefined) {
      // Route scope: stage the config onto pendingOptions so the next
      // `.from()` writes it into the new RouteDefinition.
      this.pendingOptions = {
        ...(this.pendingOptions ?? {}),
        timeoutConfig: { timeoutMs },
      };
      logger.trace("Staging route-scope timeout config for next route");
      return this;
    }
    return super.timeout(timeoutMs);
  }

  /**
   * Retry. Dual-mode:
   *
   * - **Before `.from()` (route scope):** re-runs the whole pipeline
   *   on failure at pre-from filter chain position 7 (outside
   *   `.timeout()`, inside `.error()`). Every attempt re-runs the
   *   chain tail including the cache check, so a value cached by a
   *   previous attempt short-circuits the next one. After the final
   *   attempt fails, the error reaches the route-scope `.error()`
   *   handler (when set) or the default error path.
   *
   * - **After `.from()` (step scope):** wraps the immediately-next
   *   step; see {@link StepBuilderBase.retry} for the step-scope
   *   contract.
   *
   * Route-scope re-attempts re-run user steps and their side effects;
   * wrap only the flaky step with step-scope `.retry()` when the rest
   * of the pipeline must not repeat.
   *
   * With a `.split()` in the pipeline, every child still processes to
   * completion on each attempt, but only a failure of the MAIN
   * exchange triggers a re-attempt: a failed split child resolves
   * through the per-child failure events exactly as it would without
   * `.retry()`. Wrap a flaky per-child step with step-scope `.retry()`
   * after the split instead.
   */
  override retry(options: RetryOptions = {}): this {
    if (this.currentRoute === undefined || this.pendingOptions !== undefined) {
      // Route scope: stage the resolved config (validates maxAttempts
      // at staging time) so the next `.from()` writes it into the new
      // RouteDefinition, mirroring the `.cache()` staging convention.
      this.pendingOptions = {
        ...(this.pendingOptions ?? {}),
        retryConfig: resolveRetryOptions(options),
      };
      logger.trace("Staging route-scope retry config for next route");
      return this;
    }
    return super.retry(options);
  }

  /**
   * Declare an authorization requirement on the next route. **Route-only**:
   * stages the authorizer onto the next-route options and runs at route
   * entry, before any pipeline step. Same staging convention as `.id`,
   * `.title`, `.description`, `.input`, `.output`, `.tag`, and `.batch`:
   * a route-level pipeline op (e.g. `.to()`, `.transform()`) called while
   * authorizers are staged but no new `.from()` has opened a route throws
   * RC2001. For a mid-pipeline check use `.validate(authorize({...}))`
   * directly.
   *
   * The check verifies that the inbound exchange carries an authenticated
   * principal and (optionally) that the principal has every required role
   * and scope. It does NOT issue, mint, or attach any credential: it
   * asserts an existing identity meets the criteria.
   *
   * Multiple `.authorize()` calls stack and AND-combine: each runs in
   * declaration order, so a missing role in the first call short-circuits
   * before later predicates run.
   *
   * Failures throw RC5012 (no principal) or RC5015 (principal failed the
   * role / scope / predicate check). A route-level `.error()` handler
   * catches both like any other validation failure.
   *
   * @param options - Required roles, scopes, or a custom predicate. When
   *   omitted, only existence of an authenticated principal is checked.
   *
   * @example Route-entry guard on an MCP tool
   * ```ts
   * craft()
   *   .id('delete-user')
   *   .description('Delete a user by id')
   *   .authorize({ roles: ['admin'] })
   *   .from(mcp({ annotations: { destructiveHint: true } }))
   *   .to(deleteUserDestination)
   * ```
   *
   * @example Stacked authorizers on an HTTP route
   * ```ts
   * craft()
   *   .id('admin-billing')
   *   .authorize({ roles: ['admin'] })
   *   .authorize({ scopes: ['billing:write'] })
   *   .from(http({ path: '/admin/billing', method: 'POST' }))
   *   .to(billingDestination)
   * ```
   *
   * @example Chained routes
   * ```ts
   * craft()
   *   .id('public').from(simple('hi')).to(noop())
   *   .id('admin').authorize({ roles: ['admin'] }).from(adminSrc).to(noop())
   * ```
   */
  authorize(options?: AuthorizeOptions): PreFromBuilder {
    const next = this.pendingOptions ?? {};
    const existing = next.authorizers ?? [];
    this.pendingOptions = {
      ...next,
      authorizers: [...existing, options ?? {}],
    };
    logger.trace("Staging route-scope authorization for next route");
    return this.prelude();
  }

  /**
   * Define the source of data for this route.
   * This is typically the first step in defining a route.
   *
   * @template T The type of data produced by the source
   * @param sources One or more source adapters or functions. Multiple
   *   sources require `.input({ body })` declared first (RC2001) so every
   *   ingress validates to the same body type.
   * @returns A RouteBuilder with the specified type T
   * @example
   * // Simple source with inferred type
   * .from<string[]>(http({ path: '/api/data', method: 'GET' }))
   *
   * // Source with callable function
   * .from<User[]>(async () => {
   *   const response = await fetch('https://api.example.com/users');
   *   return response.json();
   * })
   *
   * // After `.input({ body: schema })`, the schema's inferred output type
   * // flows through the chain automatically (see PreFromTypedBuilder):
   * // .input({ body: MySchema }).from(direct())
   *
   * // Expose one capability on several ingresses (internal + agents +
   * // integrations) that all feed the same pipeline. Multi-ingress requires
   * // `.input()` so every channel validates and normalizes to one body type:
   * // .input(QuerySchema).from(direct(), mcp(), http({ path: '/q', method: 'POST' }))
   *
   * The multiple-source `.input()` requirement is a deliberate build-time
   * precondition, enforced at `.from()` with RC2001 rather than in the type
   * system: the variadic overload is statically reachable on THIS class.
   * Chains that declare `.input({ body })` first go through
   * {@link PreFromTypedBuilder.from} instead, where the staged schema type
   * seeds the body so multi-ingress is typed without an explicit generic.
   */
  from<T>(source: SourceLike<T>): RouteBuilder<SetBody<S, T>>;
  from<T>(source: SourceLike<unknown>): RouteBuilder<SetBody<S, T>>;
  from<T>(
    ...sources: [
      SourceLike<unknown>,
      SourceLike<unknown>,
      ...Array<SourceLike<unknown>>,
    ]
  ): RouteBuilder<SetBody<S, T>>;
  from<T>(...sources: Array<SourceLike<T>>): RouteBuilder<SetBody<S, T>> {
    this.assertNoPendingWrappers("from");
    if (sources.length === 0) {
      throw rcError("RC2001", undefined, {
        message: `Route .from() requires at least one source.`,
      });
    }
    const id = this.pendingOptions?.id ?? randomUUID();
    const consumer = this.pendingOptions?.consumer ?? {
      type: SimpleConsumer,
      options: undefined,
    };
    const errorHandler = this.pendingOptions?.errorHandler;
    const cacheConfig = this.pendingOptions?.cacheConfig;
    const retryConfig = this.pendingOptions?.retryConfig;
    const timeoutConfig = this.pendingOptions?.timeoutConfig;
    const discovery = this.pendingOptions?.discovery;
    const authorizers = this.pendingOptions?.authorizers ?? [];

    // Multi-ingress routes feed one shared pipeline, so they need one shared
    // input contract. Require `.input()` (with a body schema) so every
    // ingress validates and normalizes its heterogeneous raw body (direct
    // `unknown`, mcp `McpMessage`, http `HttpRequestBody`) to the same type
    // before the pipeline runs. Without it the pipeline body would be an
    // unsound union of the raw source types. A single source keeps the
    // existing behaviour (type flows from `.from<T>()` or the source).
    if (sources.length > 1 && !discovery?.input?.body) {
      throw rcError("RC2001", undefined, {
        message: `Route "${id}": .from() with multiple sources requires .input({ body }) so every ingress validates to one shared body type. Declare .input() before .from(), or expose each channel as its own single-source route.`,
      });
    }

    logger.trace(
      { route: id, sourceCount: sources.length },
      "Creating route definition",
    );

    // Assemble the route's pre-from filter chain. Order is fixed by
    // `.standards/pre-from-filter-chain.md`:
    //
    //   preParseFilters   -> .authorize() (#2)
    //   parse              (#3; dynamic, source-attached, inserted at runtime)
    //   .input()           (#4; CURRENTLY EAGER -- runs in `Route.buildConsumerHandler()`
    //                       outside the chain, not in postParseFilters. See
    //                       `.standards/pre-from-filter-chain.md` for the
    //                       scoping note: folding it in changes cross-route
    //                       context:error semantics and is tracked separately.)
    //   postParseFilters  -> .cache() check (#9); reserved slots for future
    //                        .throttle() / .circuitBreaker() (positions 5-6).
    //                        Route-scope .retry() (#7) / .timeout() (#8) ride
    //                        on RouteDefinition fields instead (see below)
    //   userSteps         -> declaration order, unchanged
    //   postFromFilters   -> .cache() store (#10)
    //
    // The user does NOT control this order: `.authorize().cache()`
    // and `.cache().authorize()` produce identical chains.
    const authorizerSteps = authorizers.map(
      (opts) => new ValidateStep(authorize(opts)),
    );
    const preParseFilters: Step<Adapter>[] = authorizerSteps;

    const postParseFilters: Step<Adapter>[] = cacheConfig
      ? [buildCacheCheckStep(cacheConfig)]
      : [];

    const postFromFilters: Step<Adapter>[] = cacheConfig
      ? [buildCacheStoreStep(cacheConfig)]
      : [];

    const normalizedSources: Source<T>[] = sources.map((source) =>
      toSource(source),
    );

    this.currentRoute = {
      id,
      sources: normalizedSources,
      steps: [],
      preParseFilters,
      postParseFilters,
      postFromFilters,
      consumer: {
        type: consumer.type,
        options: consumer.options ?? undefined,
      },
      ...(errorHandler ? { errorHandler } : {}),
      ...(discovery ? { discovery } : {}),
      // Route-scope retry (#7) and timeout (#8) scope over the chain
      // tail rather than running as flat filters, so they live as
      // definition fields; the pipeline executor wraps the tail in the
      // matching segment steps. See `.standards/pre-from-filter-chain.md`.
      ...(retryConfig ? { retry: retryConfig } : {}),
      ...(timeoutConfig ? { timeout: timeoutConfig } : {}),
    };
    setBrand(this.currentRoute, BRAND.RouteDefinition);

    // Clear staged options once used
    this.pendingOptions = undefined;

    this.routes.push(this.currentRoute);
    return this.retype<T>();
  }

  /**
   * Re-surface this instance as the pre-`.from()` staging type. The single
   * cast point for the route-scope staging methods, mirroring `retype()` on
   * the base class: there is one runtime object, and position in the chain
   * decides which type-level surface is reachable.
   */
  private prelude(): PreFromBuilder {
    return this as unknown as PreFromBuilder;
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
    if (this.pendingOptions !== undefined) {
      throw rcError("RC2001", undefined, {
        message:
          `Route metadata staged but no .from() called: route-level configuration ` +
          `(.id / .title / .description / .input / .output / .batch / .error / .authorize) must be ` +
          `followed by .from() before pipeline operations on the next route.`,
      });
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
    const wrapped = this.applyPendingWrappers(step);
    // Route-scope `.cache()` + `.split()` compatibility is checked at
    // build time: a balanced `split + aggregate` route is cacheable
    // (the aggregated body is the single terminal value), but a
    // fire-and-forget split has no single result to cache. See
    // {@link assertRouteScopeCacheCompatibility} -- it walks each
    // finalised route in `build()` and throws `RC5003` for unbalanced
    // shapes. Per-step rejection at push time would refuse the
    // balanced case before the user gets a chance to add the matching
    // aggregate.
    logger.trace(
      { operation: wrapped.operation, route: route.id },
      "Adding step to route",
    );
    route.steps.push(wrapped);
  }

  /**
   * Split into multiple exchanges for fan-out. Each returned exchange is processed independently.
   * If no splitter is provided: array bodies are split into one exchange per element; non-array bodies
   * are treated as a single item (one exchange). Framework maintains `routecraft.split_hierarchy`
   * headers for aggregation.
   *
   * Splitters return the child BODIES (or `splitChild(body, headers)`
   * envelopes for per-child header overrides); the framework constructs the
   * child exchanges, assigns fresh ids, and inherits the parent's headers.
   *
   * @template ItemType The type of items in the array (inferred from array if not specified)
   * @param splitter Optional adapter or function `(exchange) => SplitResult<ItemType>[]`
   * @returns A RouteBuilder with the item type
   * @example
   * // Automatically split an array of numbers
   * .from<number[]>(source)
   * .split() // ItemType is inferred as number
   *
   * // Custom splitting logic - return the child bodies
   * .from(source)
   * .split<User>((exchange) => exchange.body.users)
   *
   * // Split a string by delimiter, with per-child header overrides
   * .split<string>((exchange) =>
   *   exchange.body.split(",").map((part, i) => splitChild(part, { "x-part": i })))
   */
  split<ItemType = S["body"] extends Array<infer U> ? U : S["body"]>(
    splitter?:
      | Splitter<S["body"], ItemType>
      | CallableSplitter<S["body"], ItemType>,
  ): RouteBuilder<SetBody<S, ItemType>> {
    // If no splitter is provided, use default splitter: arrays are split, non-arrays as single item
    if (!splitter) {
      const defaultSplitter: CallableSplitter<S["body"], ItemType> = (
        exchange,
      ) => {
        const body = exchange.body;
        return Array.isArray(body)
          ? (body as ItemType[])
          : [body as unknown as ItemType];
      };

      this.pushStep(new SplitStep<S["body"], ItemType>(defaultSplitter));
    } else {
      this.pushStep(new SplitStep<S["body"], ItemType>(splitter));
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
  aggregate<ResultType = Array<S["body"]>>(
    aggregator?:
      | Aggregator<S["body"], ResultType>
      | CallableAggregator<S["body"], ResultType>,
  ): RouteBuilder<SetBody<S, ResultType>> {
    if (!aggregator) {
      // Use default aggregator which collects bodies into an array
      this.pushStep(
        new AggregateStep<S["body"], ResultType>(
          defaultAggregate as CallableAggregator<S["body"], ResultType>,
        ),
      );
    } else {
      this.pushStep(new AggregateStep<S["body"], ResultType>(aggregator));
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
   * the current body), which becomes the body type of the builder after the choice.
   *
   * @template Out - Body type produced by every branch (enforced by the
   *   branch callback return types)
   * @param fn - Callback that populates the choice sub-builder with `when`
   *   and `otherwise` branches
   * @returns A RouteBuilder typed at `Out`
   *
   * @example
   * ```ts
   * .choice(c => c
   *   .when(ex => ex.body.priority === 'urgent', b => b.to(urgentQueue))
   *   .when(ex => ex.body.amount > 1000,         b => b.to(reviewQueue))
   *   .otherwise(                                b => b.to(errorSink).halt()))
   * .to(finalDest)
   * ```
   */
  choice<Out = S["body"]>(
    fn: (c: ChoiceSubBuilder<S, Out>) => ChoiceSubBuilder<S, Out>,
  ): RouteBuilder<SetBody<S, Out>> {
    const sub = new ChoiceSubBuilder<S, Out>();
    fn(sub);
    this.pushStep(new ChoiceStep<S["body"]>(sub[COLLECT_STEPS]()));
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
    if (this.pendingOptions !== undefined) {
      throw rcError("RC2001", undefined, {
        message: `Route metadata staged but never consumed by .from().`,
      });
    }
    this.assertNoPendingWrappers("build");
    for (const route of this.routes) {
      assertRouteScopeCacheCompatibility(route);
    }
    logger.trace({ routeCount: this.routes.length }, "Building routes");
    return this.routes;
  }

  /**
   * Throw when a step-scope wrapper (`.error()`, `.retry()`,
   * `.timeout()`, `.cache()`, `.delay()`) was staged but the user is starting a
   * new route or finalising the build without consuming it. A wrapper
   * attaches to the immediately next pipeline step; if no step
   * follows on the current route, the wrapper would silently leak
   * into the next route's first step. Symmetric with the existing
   * "metadata staged but never consumed" rule.
   *
   * @internal
   */
  private assertNoPendingWrappers(method: string): void {
    if (this.pendingStepWrappers.length > 0) {
      throw rcError("RC2001", undefined, {
        message:
          `Wrapper(s) staged via .error() / .retry() / .timeout() / .cache() / .delay() but no step followed before .${method}(). ` +
          `A wrapper attaches to the immediately next pipeline step; orphaning one (or letting it leak into the next route) is almost always a mistake.`,
      });
    }
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
export function craft(): PreFromBuilder {
  return new RouteBuilder();
}
