import { randomUUID } from "node:crypto";
import { BRAND, setBrand } from "./brand.ts";
import { DefaultRoute, type Route, type RouteDefinition } from "./route.ts";
import {
  CAPABILITY_REGISTRY,
  snapshotCapability,
  type Capability,
} from "./capabilities.ts";
import { rcError, RC } from "./error.ts";
import { isRoutecraftError } from "./brand.ts";
import { logger, childBindings } from "./logger.ts";
import { type AdapterOverride, RC_ADAPTER_OVERRIDES } from "./testing-hooks.ts";
import { getConfigAppliers } from "./config-applier.ts";
import { SUSPENSION_RUNTIME } from "./suspension/runtime-key.ts";
import { EventBus } from "./event-bus.ts";

import type { EventHandler, EventName, EventPayload } from "./types.ts";

/**
 * Store key for runner-provided argv tokens.
 *
 * Set by `craft run` (or any runner) before `context.start()` so that
 * adapters can read the remaining CLI arguments without coupling to a
 * specific runner package.
 */
export const RUNNER_ARGV: unique symbol = Symbol.for("routecraft.runner.argv");

/**
 * Base store registry that can be extended by adapters
 *
 * @example
 * ```typescript
 * // Extend the store registry with channel adapter types
 * declare module "@routecraft/routecraft" {
 *   interface StoreRegistry {
 *     "routecraft.adapter.channel.store": Map<string, import("./adapters/channel.ts").MessageChannel>;
 *     "routecraft.adapter.channel.config": Partial<ChannelAdapterOptions>;
 *   }
 * }
 * ```
 */
export interface StoreRegistry {
  [key: `${string}.${string}.${string}`]: unknown;
  [RUNNER_ARGV]: string[];
  [RC_ADAPTER_OVERRIDES]: AdapterOverride[];
}

/**
 * Options with merged configuration support.
 * This type is used for adapters that support both direct options and
 * options that can be merged with context configuration.
 */
export type MergedOptions<T> = {
  /** Direct options for configuration */
  options: Partial<T>;

  /**
   * Function to merge options with context configuration
   * @param context The CraftContext instance
   * @returns Merged options
   */
  mergedOptions(context: CraftContext): T;
};

/**
 * A plugin configures the context and may own work for as long as it runs.
 *
 * Three phases, each answering a different question:
 *
 * - `apply(ctx)` wires the context, before routes are registered
 *   (`initPlugins()`). Nothing is running yet.
 * - `start(ctx)` begins work, after every route has started. Optional.
 * - `teardown(ctx)` releases whatever the other two acquired, when the
 *   context stops and routes have drained. Optional.
 *
 * The split matters for anything with a lifetime. A plugin that opens a
 * handle does it in `apply()`; a plugin that starts a timer or drives routes
 * does it in `start()`, because at `apply()` time there are no routes to
 * drive. Either way `teardown()` is what releases it.
 *
 * Plugins needing neither can omit both; use `ctx.registerTeardown()` from
 * `apply()` for one-off cleanup callbacks.
 */
export interface CraftPlugin {
  /**
   * Stable identifier for the plugin, surfaced as `pluginId` on
   * `plugin:*` event payloads and in logs. Falls back to the plugin's
   * constructor name (or `plugin-<index>`) when omitted.
   */
  name?: string;
  /**
   * RESERVED. Names of plugins this plugin depends on. Not enforced yet:
   * declaring it today has no effect, but the key is reserved so a
   * future dependency-ordered initialisation can use it without a
   * breaking change.
   */
  dependsOn?: string[];
  /** Keep the context running after all routes complete until `stop()` is called. */
  keepsAlive?: boolean;
  apply(ctx: CraftContext): void | Promise<void>;
  /**
   * Called once per context start, after every route has been started, in
   * plugin registration order. Awaited. Optional.
   *
   * This is where a plugin owning a background task belongs, because
   * `apply()` runs at build time when no route is running yet. A plugin
   * that starts something here MUST stop it in {@link CraftPlugin.teardown}:
   * a live interval keeps the process alive with no visible cause.
   *
   * A throw fails `context.start()`. The context then shuts down (routes
   * aborted and drained, every plugin torn down in reverse order) and the
   * original error is rethrown unchanged, so a plugin that fails to start
   * cannot leave a half-running context behind.
   */
  start?(ctx: CraftContext): void | Promise<void>;
  /**
   * Called when the context stops, after routes have drained, and when a
   * build or a start failed partway. Optional.
   *
   * The second argument says which of those happened, so a plugin never has
   * to infer it from its own state. Ignore it and the hook behaves exactly
   * as it did when teardown only ran on a fully started context; read it
   * when releasing depends on how far the context got.
   */
  teardown?(ctx: CraftContext, info: TeardownInfo): void | Promise<void>;
}

/**
 * What the context managed to do before this teardown, handed to every
 * {@link CraftPlugin.teardown}.
 *
 * The distinction exists because teardown now runs on three different
 * shapes of context: one that started and is stopping, one whose build
 * failed with only some plugins applied, and one whose start failed with
 * only some plugins started. A plugin that closes what `apply()` opened
 * needs none of this; a plugin that stops what `start()` began must not be
 * told to stop something it never began.
 */
export interface TeardownInfo {
  /**
   * The context never finished starting. Either the build failed partway
   * (routes are not registered, later plugins never applied) or a `start()`
   * hook threw. State a plugin would normally expect a running context to
   * hold may be missing.
   */
  partial: boolean;
  /**
   * THIS plugin's own `start()` hook ran to completion. Always false for a
   * plugin with no `start()` hook, and false during a build-failure unwind,
   * where nothing started.
   */
  started: boolean;
}

/**
 * How long `start()` waits for routes to signal readiness before starting
 * plugins anyway. Generous, because it is a backstop against a source that
 * never signals rather than a deadline anything healthy approaches.
 */
const ROUTE_READINESS_TIMEOUT_MS = 30_000;

/**
 * What became of one route by the time the readiness gate settled.
 * `waiting` means the backstop fired before the route signalled, which is
 * a different operational problem from a route that failed outright.
 */
type RouteBootOutcome = "started" | "failed" | "waiting";

/**
 * Config keys handled directly by the CraftContext constructor, as opposed
 * to keys claimed by registered config appliers. Used to detect config keys
 * that nothing consumes. Must stay in sync with the fields of
 * {@link CraftConfig} declared in this file (ecosystem augmentations are
 * covered by the applier registry instead).
 */
const BASE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "name",
  "store",
  "on",
  "once",
  "plugins",
]);

/**
 * Configuration options for creating a CraftContext.
 *
 * Declared as an `interface` so ecosystem packages can extend it via
 * declaration merging. Pair an augmentation with `registerConfigApplier`
 * to promote an ecosystem capability to a first-class config key.
 *
 * @example
 * ```typescript
 * declare module "@routecraft/routecraft" {
 *   interface CraftConfig {
 *     myCapability?: MyCapabilityOptions;
 *   }
 * }
 * ```
 */
export interface CraftConfig {
  /**
   * Service / application name for this context. Emitted on every log line as
   * `service.name` (the OpenTelemetry semantic convention), so log aggregators
   * that map OTel resource attributes (e.g. BetterStack `resources.service.name`)
   * can identify the originating app. When omitted, no `service.name` field is
   * added to logs.
   */
  name?: string;
  /** Initial values for the context store */
  store?: Map<keyof StoreRegistry, StoreRegistry[keyof StoreRegistry]>;
  /** Event handlers to register on context creation */
  on?: Partial<
    Record<EventName, EventHandler<EventName> | EventHandler<EventName>[]>
  >;
  /** One-time event handlers to register on context creation (fire once, then auto-unsubscribe) */
  once?: Partial<
    Record<EventName, EventHandler<EventName> | EventHandler<EventName>[]>
  >;
  /** Plugins to run before routes are registered (call initPlugins() then registerRoutes) */
  plugins?: CraftPlugin[];
}

/**
 * The main context for running and managing routes.
 *
 * CraftContext is the central runtime environment that:
 * - Manages the lifecycle of routes
 * - Provides a storage system for adapters
 * - Handles startup and shutdown of the application
 *
 * @example
 * ```typescript
 * // Create a context with routes and event handlers
 * const context = new CraftContext({
 *   on: {
 *     'context:starting': async () => {
 *       console.log('Starting application');
 *     },
 *     'context:stopping': async () => {
 *       console.log('Shutting down application');
 *     }
 *   }
 * });
 *
 * // Register routes
 * context.registerRoutes(myRoute1, myRoute2);
 *
 * // Start processing routes
 * await context.start();
 *
 * // Later, stop all routes
 * await context.stop();
 * ```
 */
export class CraftContext {
  /** Unique identifier for this context instance */
  public readonly contextId: string = randomUUID();

  /** Service / application name, surfaced on logs as `service.name`. */
  public readonly name?: string;

  /** Routes registered with this context */
  private routes: Route[] = [];

  /** Abort controllers for each route */
  private controllers: Map<string, AbortController> = new Map();

  /** Storage for adapter configuration and state */
  private store = new Map<
    keyof StoreRegistry,
    StoreRegistry[keyof StoreRegistry]
  >();

  /** Logger for this context (pino child logger) */
  public readonly logger: ReturnType<typeof logger.child>;

  /** Event bus backing on/once/emit (see event-bus.ts) */
  private readonly events: EventBus;

  /** Plugins from config, run by initPlugins() before routes are registered */
  private readonly plugins: CraftPlugin[] = [];

  /** Guards initPlugins() so start() can call it idempotently */
  private pluginsInitialized = false;

  /**
   * Indices of plugins whose `apply()` returned. Teardown walks this rather
   * than the whole plugin list: a build that failed at plugin 3 must not
   * tear down plugin 4, which never ran.
   */
  private readonly appliedPlugins = new Set<number>();

  /** Indices of plugins whose `start()` hook returned. */
  private readonly startedPlugins = new Set<number>();

  /** Latched once `start()` has fully completed, for {@link TeardownInfo.partial}. */
  private startCompleted = false;

  /** Teardown callbacks registered by plugins; run during stop() before context:stopped */
  private readonly teardownCallbacks: Array<() => void | Promise<void>> = [];

  /** Cached shutdown promise so concurrent stop() callers all await the same teardown */
  private shutdownPromise: Promise<void> | null = null;

  /** Backing deferred for {@link CraftContext.whenStarted}. */
  private startedDeferred: PromiseWithResolvers<void> | undefined;

  /** The in-flight start, so concurrent `start()` calls join one boot. */
  private startInFlight: Promise<void> | undefined;

  /** Latched by `stop()`. A stopped context refuses to start again. */
  private hasStopped = false;

  /**
   * Create a new CraftContext instance.
   *
   * @param config Optional configuration for the context
   */
  constructor(config?: CraftConfig) {
    setBrand(this, BRAND.CraftContext);
    if (config?.name !== undefined) this.name = config.name;
    this.logger = logger.child(childBindings(this));
    this.events = new EventBus(this.contextId, this.logger);
    if (config) {
      // Initialize store from config
      if (config.store) {
        for (const [key, value] of config.store.entries()) {
          this.store.set(key, value);
        }
      }

      // Register event handlers from config
      if (config.on) {
        for (const [event, handler] of Object.entries(config.on)) {
          if (Array.isArray(handler)) {
            handler.forEach((h) => this.on(event as EventName, h));
          } else if (handler) {
            this.on(event as EventName, handler);
          }
        }
      }

      // Register one-time event handlers from config
      if (config.once) {
        for (const [event, handler] of Object.entries(config.once)) {
          if (Array.isArray(handler)) {
            handler.forEach((h) => this.once(event as EventName, h));
          } else if (handler) {
            this.once(event as EventName, handler);
          }
        }
      }
      // Walk registered config appliers. ALL first-class config keys go
      // through this registry: core keys (`http`, `cron`, `direct`, `mail`,
      // `telemetry`) are registered by side-effect imports in index.ts, and
      // ecosystem packages (e.g. @routecraft/ai promotes `llm`, `mcp`,
      // `embedding`, `agent`) extend it the same way. The core context has
      // no knowledge of any adapter or plugin internals.
      //
      // The push order into `this.plugins` drives both apply() order
      // (forward) and teardown() order (reverse):
      //   1. registered appliers, in registration order (core keys first,
      //      since index.ts imports run before ecosystem modules load)
      //   2. user config.plugins
      //
      // Reverse-iteration in performShutdown() therefore tears down user
      // plugins first, then appliers in reverse registration order.
      //
      // The applier guard is strictly `value !== undefined`, not a truthy
      // check. The applier registry is an open extension point: ecosystem
      // packages can register appliers for any value shape, including
      // primitives where `false`, `0`, or `""` are valid. "Not set" must
      // mean only `undefined` so applier authors can rely on a stable
      // contract regardless of value type.
      const configRecord = config as unknown as Record<string, unknown>;
      const applierKeys = new Set<string>();
      for (const [key, factory] of getConfigAppliers()) {
        applierKeys.add(key);
        const value = configRecord[key];
        if (value !== undefined) {
          this.plugins.push(factory(value));
        }
      }

      // A set config key that is neither a base key nor a registered applier
      // is dead weight: a typo (`htttp`), or an applier whose registering
      // module never loaded (the config-applier bundle regression shipped
      // exactly this way, with `mail: {...}` silently ignored). Warn instead
      // of throwing because appliers are an open registry and a false
      // positive must not take down an otherwise valid context.
      for (const key of Object.keys(configRecord)) {
        if (configRecord[key] === undefined) continue;
        if (BASE_CONFIG_KEYS.has(key) || applierKeys.has(key)) continue;
        this.logger.warn(
          { configKey: key },
          `Unknown config key "${key}": no config applier is registered for it, so it has no effect. ` +
            `Check the spelling, and ensure the package that provides the key is imported before the context is created.`,
        );
      }

      if (config.plugins?.length) {
        this.plugins.push(...config.plugins);
      }
    }
  }

  /**
   * Generate a plugin identifier from the plugin's constructor name or index.
   * @param plugin The plugin instance
   * @param index The plugin's index in the plugins array
   * @returns A string identifier for the plugin
   */
  private getPluginId(plugin: CraftPlugin, index: number): string {
    if (typeof plugin.name === "string" && plugin.name) return plugin.name;
    const constructorName =
      plugin.constructor?.name !== "Object" ? plugin.constructor?.name : null;
    return constructorName ?? `plugin-${index}`;
  }

  /**
   * Run plugins from config. Called by the builder's `build()` (and by
   * `start()` as an idempotent fallback) before routes are registered so
   * plugins can set up state or dynamically add routes.
   *
   * Fails fast: on first plugin error, logs, emits `error`, and rethrows.
   *
   * @throws Rethrows if any plugin's `apply(ctx)` throws
   * @internal Public for the builder and tests; not part of the supported
   *   embedding surface. The context initialises plugins itself.
   */
  async initPlugins(): Promise<void> {
    if (this.pluginsInitialized) return;
    this.pluginsInitialized = true;
    for (const [pluginIndex, plugin] of this.plugins.entries()) {
      try {
        if (
          !plugin ||
          typeof plugin !== "object" ||
          typeof (plugin as CraftPlugin).apply !== "function"
        ) {
          const err = rcError("RC9901", undefined, {
            message: `Invalid plugin at index ${pluginIndex}: expected object with apply(ctx)`,
          });
          this.logger.error(
            { pluginIndex, err },
            "Invalid plugin: expected object with apply(ctx) method.",
          );
          this.emit("context:error", { error: err });
          throw err;
        }

        // Generate plugin ID from constructor name or index
        const pluginId = this.getPluginId(plugin as CraftPlugin, pluginIndex);

        // Plugins are "registered" at construction; a separate
        // plugin:registered event fired at the same moment with the same
        // payload carried no extra information and was removed.
        this.emit("plugin:applying", {
          pluginId,
          pluginIndex,
        });

        await (plugin as CraftPlugin).apply(this);
        this.appliedPlugins.add(pluginIndex);

        this.emit("plugin:applied", {
          pluginId,
          pluginIndex,
        });
      } catch (err) {
        this.logger.error(
          { pluginIndex, err },
          "Plugin threw during initPlugins. Check stack and plugin implementation.",
        );
        this.emit("context:error", { error: err });
        throw err;
      }
    }
  }

  /**
   * Resolves once the context is fully started: every route has emitted
   * `route:started` AND every plugin `start()` hook has resolved.
   *
   * `context.start()` cannot answer this, because it does not resolve until
   * the routes complete, and an http or cron route completes at shutdown.
   * Waiting on `route:started` alone answers only two thirds of the
   * lifecycle, which is why anything needing a started context (a test
   * harness, a readiness probe) waits here instead.
   *
   * A hook that performs bounded startup work is awaited by this, on
   * purpose: the suspension sweeper's downtime scan has RUN by the time
   * this resolves, so overdue expiries reach their routes before new
   * traffic does. Rejects with the error that refused the start, which is a
   * plugin `start()` hook or the context's own config. A single route that
   * fails to come up is NOT observable here: `start()` keeps the remaining
   * routes running by design, so a probe that must know a specific route is
   * serving watches `route:started` for it.
   *
   * A context starts once (`start()` after `stop()` refuses with RC1004),
   * so this settles exactly once and keeps reporting that outcome.
   */
  whenStarted(): Promise<void> {
    return this.ensureStartedDeferred().promise;
  }

  /**
   * The deferred behind {@link CraftContext.whenStarted}, created on first
   * use by either side.
   *
   * Lazy because most contexts never ask, and shared because `start()` has
   * to settle the same promise a caller may already be holding.
   *
   * @internal
   */
  private ensureStartedDeferred(): PromiseWithResolvers<void> {
    if (!this.startedDeferred) {
      const deferred = Promise.withResolvers<void>();
      // Nobody is obliged to await this, and a refused start must not
      // surface as an unhandled rejection on top of the error start()
      // already throws.
      deferred.promise.catch(() => {});
      this.startedDeferred = deferred;
    }
    return this.startedDeferred;
  }

  /**
   * Resolve once every route has signalled readiness, or stopped trying.
   *
   * `Promise.allSettled` over the route starts cannot answer this: each
   * mapped function runs only as far as its first `await`, so it returns
   * when every route has ENTERED `start()`, not when its sources are
   * listening. A plugin whose `start()` hook talks to a route would race
   * the source's subscribe, and a readiness probe would report a context
   * ready before its HTTP port was bound.
   *
   * A route that fails or completes counts as settled rather than ready.
   * One failing route does not fail the context (`start()` keeps the others
   * running by design), so readiness cannot report it either: what this
   * waits for is that no route is still coming up, not that all of them did.
   *
   * The wait is bounded because readiness is not something every source
   * signals. Everything `.from()` normalizes signals it (the iterable path
   * from its loop, a bare callable on invocation), but a hand-written
   * `Source` adapter that never calls `ready()` and never emits would
   * otherwise hold the whole context down forever. The bound is a guard
   * against that, not a deadline anything healthy approaches.
   *
   * @internal
   */
  private awaitRoutesStarted(): {
    ready: Promise<void>;
    settle: (routeId: string, outcome: RouteBootOutcome) => void;
    outcomes: Map<string, RouteBootOutcome>;
  } {
    const pending = new Map<string, { resolve: () => void }>();
    const outcomes = new Map<string, RouteBootOutcome>(
      this.routes.map((route) => [route.definition.id, "waiting" as const]),
    );
    const waits = this.routes.map(
      (route) =>
        new Promise<void>((resolve) => {
          pending.set(route.definition.id, { resolve });
        }),
    );
    const off = this.on("route:started", ({ details }) => {
      outcomes.set(details.routeId, "started");
      pending.get(details.routeId)?.resolve();
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn(
          { timeoutMs: ROUTE_READINESS_TIMEOUT_MS },
          "Some routes did not signal readiness in time; starting plugins anyway. A Source adapter that never calls ready() and never emits reaches readiness only when it produces its first message.",
        );
        resolve();
      }, ROUTE_READINESS_TIMEOUT_MS);
      timer.unref?.();
    });

    return {
      ready: Promise.race([Promise.all(waits).then(() => {}), bound]).finally(
        () => {
          off();
          if (timer) clearTimeout(timer);
        },
      ),
      // A route that failed or completed counts as settled, not started, so
      // the gate stops waiting on it while the summary still reports what
      // actually happened to it.
      settle: (routeId: string, outcome: RouteBootOutcome) => {
        if (outcomes.get(routeId) !== "started") outcomes.set(routeId, outcome);
        pending.get(routeId)?.resolve();
      },
      outcomes,
    };
  }

  /**
   * Log one line saying whether the boot came up, after the readiness gate
   * settles.
   *
   * `whenStarted()` deliberately cannot report a single route failing to
   * bind, because partial availability is the design: one route failing
   * does not fail the context. That leaves an operator watching a boot with
   * no single answer to "did everything come up", visible only to whoever
   * subscribed to `route:started` at the right moment. This is that answer,
   * and nothing more: no new events, no semantics change.
   */
  private logBootSummary(outcomes: Map<string, RouteBootOutcome>): void {
    const by = (outcome: RouteBootOutcome): string[] =>
      [...outcomes.entries()]
        .filter(([, value]) => value === outcome)
        .map(([routeId]) => routeId);

    const started = by("started");
    const failed = by("failed");
    const waiting = by("waiting");
    const total = outcomes.size;
    const summary = {
      started: started.length,
      total,
      ...(failed.length > 0 ? { failed } : {}),
      ...(waiting.length > 0 ? { waiting } : {}),
    };
    const line = `Routes started: ${started.length} of ${total}`;
    if (failed.length > 0 || waiting.length > 0) {
      this.logger.warn(summary, line);
    } else {
      this.logger.info(summary, line);
    }
  }

  /**
   * Run every plugin's optional `start()`, in registration order.
   *
   * Separate from {@link CraftContext.initPlugins} because the two phases
   * answer different questions. `apply()` wires the context and runs at
   * build time; `start()` begins work and needs the routes running. The
   * suspension sweeper is the first consumer: it re-enters a route's error
   * channel when a parked exchange expires, which is not something that can
   * be done against a route that has not started.
   *
   * A throw propagates to `context.start()`, which shuts the context down
   * before rethrowing it unchanged. Unwinding a partially started context
   * is deliberately the existing shutdown path rather than a second
   * mechanism, so a plugin's stop logic has one home. Build-time unwind of
   * applied-but-not-started plugins is tracked separately in #565.
   */
  private async startPlugins(): Promise<void> {
    for (const [pluginIndex, plugin] of this.plugins.entries()) {
      // Re-checked per hook, not only on entry: a stop() arriving while an
      // earlier hook is mid-await has already torn the plugins down, and a
      // hook launched after that begins work nothing will ever stop.
      if (this.hasStopped) return;
      if (typeof plugin.start !== "function") continue;
      const pluginId = this.getPluginId(plugin, pluginIndex);
      try {
        this.emit("plugin:starting", { pluginId, pluginIndex });
        await plugin.start(this);
        this.startedPlugins.add(pluginIndex);
        this.emit("plugin:started", { pluginId, pluginIndex });
      } catch (err) {
        this.logger.error(
          { pluginIndex, pluginId, err },
          "Plugin threw during start(). The context will not start.",
        );
        this.emit("context:error", { error: err });
        throw err;
      }
    }
  }

  /**
   * Refuse to start when a route can reach a `.suspend()` and nothing
   * configured where parked exchanges go.
   *
   * Deliberately not auto-provisioned. The suspension runtime decides
   * whether this deployment survives a restart and whether resume tokens
   * outlive the process, and defaulting it silently would hand a route that
   * promises durability an in-memory store nobody chose. Failing at startup
   * costs one config line; failing on the first large payout costs the
   * payout.
   *
   * Routes that never touch suspension carry neither marker, so a context
   * without the feature pays nothing here.
   *
   * @throws RC5052 when a suspendable route has no suspension runtime
   */
  private assertSuspensionConfigured(): void {
    if (this.getStore(SUSPENSION_RUNTIME)) return;
    const suspending = this.routes.find(
      (route) => (route.definition.suspendSteps?.length ?? 0) > 0,
    );
    // A resume ingress needs the runtime just as much: it verifies tokens
    // against the signer and reads the store. Left out, a resume-only
    // deployment starts clean and refuses every answer at request time.
    const resuming = this.routes.find((route) => route.definition.usesResume);
    const offender = suspending ?? resuming;
    if (!offender) return;
    const reached = suspending ? ".suspend()" : ".resume()";
    const err = rcError("RC5052", undefined, {
      message: `Route "${offender.definition.id}" can reach a ${reached}, but this context has no suspension runtime. Add suspension: {} to defineConfig (or suspension: { store, secret } to be explicit).`,
    });
    // Emitted as well as thrown, matching the plugin-init failure path: a
    // caller that never awaits `start()` (every long-running source holds
    // it open until shutdown) would otherwise only see this as an
    // unobserved rejection.
    this.logger.fatal({ err }, err.meta.message);
    this.emit("context:error", { error: err });
    throw err;
  }

  /**
   * Register a teardown callback to run when the context stops. Plugins use this
   * to release resources (e.g. caches, native handles) after routes have drained.
   * Callbacks run in REVERSE registration order (LIFO, mirroring plugin
   * teardown) before `context:stopped` is emitted, so resources unwind in
   * the opposite order they were acquired.
   *
   * @param fn - Callback (sync or async) to run during stop()
   */
  registerTeardown(fn: () => void | Promise<void>): void {
    this.teardownCallbacks.push(fn);
  }

  /**
   * Subscribe to lifecycle and system events.
   *
   * **Wildcard Patterns:**
   *
   * - `*` (single-level wildcard): Matches exactly one segment
   *   - Pattern and event must have the same number of colon-separated segments
   *   - Example: `route:*` matches `route:started` (2 segments), but NOT `route:payment:exchange:started` (4 segments)
   *
   * - `**` (globstar wildcard): Matches zero or more segments at any level
   *   - Example: `route:**` matches `route:started`, `route:payment:exchange:started`, etc.
   *   - Example: `route:*:operation:**` matches all operations with any adapter depth
   *
   * @param event - Event name or wildcard pattern (e.g. `route:started`, `route:*`, `route:**`)
   * @param handler - Callback receiving `{ ts, contextId, details }`
   * @returns Unsubscribe function (call to remove the handler)
   *
   * @example
   * ```typescript
   * // Subscribe to specific event
   * const unsubscribe = ctx.on('route:started', ({ details }) => {
   *   console.log('Route started:', details.route.definition.id);
   * });
   *
   * // Subscribe to all static route events (2 segments)
   * ctx.on('route:*', ({ details }) => {
   *   console.log('Route event:', details);
   * });
   *
   * // Subscribe to all route events at any depth (globstar)
   * ctx.on('route:**', ({ details }) => {
   *   console.log('Route event at any depth:', details);
   * });
   *
   * // Subscribe to all exchange events (4 segments)
   * ctx.on('route:*:exchange:*', ({ details }) => {
   *   console.log('Exchange event:', details);
   * });
   *
   * // later: unsubscribe();
   * ```
   */
  on<K extends EventName>(event: K, handler: EventHandler<K>): () => void;
  on(event: "*", handler: EventHandler<EventName>): () => void;
  on(event: EventName | "*", handler: EventHandler<EventName>): () => void {
    return this.events.on(event as EventName, handler);
  }

  /**
   * Subscribe to an event for a single occurrence. The handler is automatically
   * removed after the first time the event is emitted.
   *
   * Supports the same wildcard patterns as `on()`.
   *
   * @param event - Event name or wildcard pattern
   * @param handler - Callback receiving `{ ts, contextId, details }`
   * @returns Unsubscribe function (call to remove the handler before it fires)
   *
   * @example
   * ```typescript
   * // Wait for context to start
   * ctx.once('context:started', () => {
   *   console.log('Context started!');
   * });
   *
   * // Wait for any route to start
   * ctx.once('route:*', ({ details }) => {
   *   console.log('First route started:', details);
   * });
   * ```
   */
  once<K extends EventName>(event: K, handler: EventHandler<K>): () => void;
  once(event: "*", handler: EventHandler<EventName>): () => void;
  once(event: EventName | "*", handler: EventHandler<EventName>): () => void {
    return this.events.once(event as EventName, handler);
  }

  /**
   * Emit an event to registered handlers.
   *
   * @param event - Event name
   * @param details - Event-specific payload (merged into `EventPayload.details`)
   * @internal Public for use by routes/adapters; prefer subscribing via on()
   */
  emit<K extends EventName>(
    event: K,
    details: EventPayload<K>["details"],
  ): void {
    this.events.emit(event, details);
  }

  // onStartup/onShutdown removed in favor of event listeners

  /**
   * Register routes with this context.
   *
   * @param definitions Route definitions to register
   * @throws {RoutecraftError} If there are duplicate route IDs or invalid route definitions
   *
   * @example
   * ```typescript
   * // Register a single route
   * context.registerRoutes(myRoute);
   *
   * // Register multiple routes
   * context.registerRoutes(route1, route2, route3);
   * ```
   */
  registerRoutes(...definitions: RouteDefinition[]): void {
    // 1) Gather all IDs from the new route definitions
    const allIDs = definitions.map((def) => def.id);

    // 2) Check for duplicates within the new route definitions
    const hasInternalDuplicates = allIDs.some(
      (id, idx) => allIDs.indexOf(id) !== idx,
    );

    // 3) Check for duplicates against existing routes
    const conflictWithExistingRoutes = definitions.some((def) =>
      this.routes.some((r) => r.definition.id === def.id),
    );

    // 4) If either case has duplicates, throw the error
    if (hasInternalDuplicates || conflictWithExistingRoutes) {
      // Identify any one duplicate ID
      const duplicateId =
        allIDs.find((id, idx) => allIDs.indexOf(id) !== idx) ??
        definitions.find((def) =>
          this.routes.some((r) => r.definition.id === def.id),
        )?.id ??
        "unknown";

      throw rcError("RC1002", undefined, {
        message: `${RC["RC1002"].message}: ${duplicateId}`,
      });
    }

    // 5) Register each definition now that there's no duplication
    for (const definition of definitions) {
      if (
        !Array.isArray(definition.sources) ||
        definition.sources.length === 0 ||
        definition.sources.some(
          (source) => !source || typeof source.subscribe !== "function",
        )
      ) {
        throw rcError("RC1001", undefined, {
          message: `${RC["RC1001"].message}: ${definition.id}`,
        });
      }

      // Binder injection removed

      const controller = new AbortController();
      this.controllers.set(definition.id, controller);
      const route = new DefaultRoute(this, definition, controller);
      this.routes.push(route);
      this.emit("route:registered", { routeId: definition.id, route });
    }
  }

  /**
   * Get all routes registered with this context.
   *
   * @returns A copy of the route list. Mutating the returned array does
   *   not affect the context; routes are managed via `registerRoutes()`.
   */
  getRoutes(): Route[] {
    return [...this.routes];
  }

  /**
   * List the discoverable capabilities registered in this context: every
   * direct endpoint together with its route's discovery metadata. Agents
   * and embedding code use this instead of reaching into the (internal)
   * direct registry; dispatch into a capability with
   * `CraftClient.sendDirect(capability.endpoint, body)`.
   *
   * @returns A fresh array of capability snapshots. Endpoints are the raw
   *   ids as passed to `.id(...)`; mutating the result does not affect
   *   the registry.
   */
  capabilities(): Capability[] {
    const registry = this.getStore(CAPABILITY_REGISTRY);
    if (!registry) return [];
    return [...registry.values()].map(snapshotCapability);
  }

  /**
   * Get a value from the context store.
   *
   * @template K Store key type
   * @param key The store key to retrieve
   * @returns The stored value or undefined if not found
   *
   * @example
   * ```typescript
   * // Get channel store
   * const channelStore = context.getStore('routecraft.adapter.channel.store');
   * ```
   */
  getStore<K extends keyof StoreRegistry>(
    key: K,
  ): StoreRegistry[K] | undefined {
    const value = this.store.get(key);
    return value as StoreRegistry[K] | undefined;
  }

  /**
   * Set a value in the context store.
   *
   * @template K Store key type
   * @param key The store key
   * @param value The value to store
   *
   * @example
   * ```typescript
   * // Set channel store
   * context.setStore('routecraft.adapter.channel.store', new Map());
   * ```
   */
  setStore<K extends keyof StoreRegistry>(
    key: K,
    value: StoreRegistry[K],
  ): void {
    this.store.set(key, value);
  }

  /**
   * Find a route by its ID.
   *
   * @param id The route ID to find
   * @returns The matching route or undefined if not found
   */
  getRouteById(id: string): Route | undefined {
    return this.routes.find((route) => route.definition.id === id);
  }

  /**
   * Start all routes registered with this context.
   *
   * Emits `context:starting` and `context:started`, then starts all routes in parallel.
   * If all routes complete (e.g. finite sources), the context automatically stops.
   * If any route fails to start, the error is logged, emitted as `error`, and rethrown.
   *
   * **Context Lifecycle Events:**
   * - `context:starting` - Context initialization begins
   * - `context:started` - Context initialized (routes may not be started yet)
   * - `context:stopping` - Context shutdown begins
   * - `context:stopped` - Context shutdown complete
   *
   * **Note:** `context:started` fires after context initialization but BEFORE
   * individual routes start. To track route readiness, subscribe to
   * `route:started` or `route:stopping` events instead.
   * To filter by specific route, inspect details.route.definition.id in the handler.
   *
   * @returns A promise that resolves when all routes have started (or when context stops)
   * @throws If any route fails to start
   *
   * @example
   * ```typescript
   * try {
   *   await context.start();
   *   console.log('All routes started successfully');
   * } catch (error) {
   *   console.error('Failed to start routes:', error);
   * }
   * ```
   */
  async start(): Promise<void> {
    // A context is single-use. Route controllers are built once and never
    // rebuilt, so a start after a stop would report ready over dead routes
    // and the suspension scan would retire records into them. The real
    // restart unit is the process; refuse loudly rather than half-run.
    if (this.hasStopped) {
      throw rcError("RC1004", undefined, {
        message:
          "This context has been stopped and cannot be started again. Build a fresh context from your config.",
      });
    }
    // Two concurrent starts collapse into one: a double boot would run every
    // plugin start() hook twice and orphan the first run's background tasks.
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = this.run();
    return this.startInFlight;
  }

  private async run(): Promise<void> {
    const started = this.ensureStartedDeferred();
    try {
      // Idempotent: ContextBuilder.build() may already have run plugins.
      // Guarantees directly-constructed contexts get config-applier wiring
      // before routes run.
      if (!this.pluginsInitialized) {
        await this.initPlugins();
      }
      this.assertSuspensionConfigured();
    } catch (err) {
      // Every exit settles the deferred: a readiness probe waiting on a
      // context that refused its config must see the refusal.
      started.reject(err);
      throw err;
    }
    this.logger.info(
      { routeCount: this.routes.length },
      "Starting Routecraft context",
    );
    this.emit("context:starting", {});

    this.logger.debug({}, "Starting all routes");
    this.emit("context:started", {});
    const routes = this.awaitRoutesStarted();
    const running = Promise.allSettled(
      this.routes.map(async (route) => {
        try {
          this.logger.info({ route: route.definition.id }, "Starting route");
          this.emit("route:starting", {
            routeId: route.definition.id,
            route,
          });
          await route.start();
          // Only log if the route completed on its own (not via context.stop())
          if (!this.shutdownPromise) {
            this.logger.info({ route: route.definition.id }, "Route completed");
          }
          routes.settle(route.definition.id, "started");
          return { routeId: route.definition.id, success: true as const };
        } catch (error) {
          const msg = isRoutecraftError(error)
            ? (error as { meta: { message: string } }).meta.message
            : error instanceof Error
              ? error.message
              : "Route failed to start";
          this.logger.fatal({ route: route.definition.id, err: error }, msg);
          this.emit("context:error", { error, route });
          // Abort just this failing route
          const controller = this.controllers.get(route.definition.id);
          controller?.abort();
          routes.settle(route.definition.id, "failed");
          throw error;
        }
      }),
    );

    // After the routes are listening: a plugin's background task may drive
    // them, and `allSettled` above keeps the route promises handled even
    // when a plugin refuses to start.
    try {
      await routes.ready;
      this.logBootSummary(routes.outcomes);
      // Re-checked after the wait: a stop() arriving while routes were
      // still coming up has already torn the plugins down, and a start()
      // hook run now would begin work on a stopped context with nothing
      // left to ever tear it down.
      if (!this.hasStopped) await this.startPlugins();
    } catch (err) {
      started.reject(err);
      try {
        await this.stop();
      } catch (stopErr) {
        // The unwind's own failure must not replace the boot error: the
        // operator needs the cause of the failed start, not what the
        // cleanup hit on the way out.
        this.logger.error(
          { err: stopErr },
          "Shutdown after a failed start also failed; reporting the start error.",
        );
      }
      await running;
      throw err;
    }
    if (this.hasStopped) {
      started.reject(
        rcError("RC1004", undefined, {
          message: "The context was stopped before it finished starting.",
        }),
      );
    } else {
      this.startCompleted = true;
      started.resolve();
    }

    return running
      .then((results) => {
        // Skip if shutdown was already triggered (e.g. via signal handler)
        if (this.shutdownPromise) return this.shutdownPromise;

        // Check if all routes completed successfully
        const allFulfilled = results.every((r) => r.status === "fulfilled");
        if (allFulfilled && !this.plugins.some((plugin) => plugin.keepsAlive)) {
          this.logger.debug({}, "All routes have completed. Stopping context.");
          return this.stop();
        } else {
          this.logger.info(
            {},
            "Some routes ended or failed; context remains active. Call context.stop() or let other indefinite routes continue.",
          );
          // Do not stop automatically; let other routes run.
          return;
        }
      })
      .catch((error) => {
        const msg = isRoutecraftError(error)
          ? (error as { meta: { message: string } }).meta.message
          : error instanceof Error
            ? error.message
            : "Context start failed";
        this.logger.fatal({ err: error }, msg);
        this.emit("context:error", { error });
        throw error;
      });
  }

  /**
   * Wait for all in-flight route handlers (and their background tasks) to complete.
   * Does not stop sources; use stop() for full shutdown.
   *
   * @returns A promise that resolves when all routes have drained
   */
  async drain(): Promise<void> {
    this.logger.debug(
      { routeCount: this.routes.length },
      "Draining context: waiting for all route handlers and tasks",
    );
    await Promise.all(this.routes.map((r) => r.drain()));
    this.logger.debug({}, "Context drained");
  }

  /**
   * Stop all routes and shut down the context.
   *
   * This will:
   * 1. Abort all route controllers (stops sources)
   * 2. Drain all routes (wait for in-flight handlers and their background tasks)
   *
   * @returns A promise that resolves when all shutdown operations complete
   *
   * @example
   * ```typescript
   * // Handle shutdown signals
   * process.on('SIGINT', async () => {
   *   console.log('Shutting down...');
   *   await context.stop();
   *   process.exit(0);
   * });
   * ```
   */
  async stop(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.hasStopped = true;
    // Settles readiness for a context stopped before it ever became ready,
    // so a probe observes termination instead of waiting forever. A no-op
    // when the deferred already settled, which is every ordinary shutdown.
    this.ensureStartedDeferred().reject(
      rcError("RC1004", undefined, {
        message: "The context was stopped before it finished starting.",
      }),
    );
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  /**
   * Tear down every plugin that applied, in reverse application order, then
   * the registered teardown callbacks.
   *
   * One walk serves all three exits: an ordinary shutdown, a start that
   * failed partway, and a build that failed partway. They differ only in
   * what {@link TeardownInfo} reports, which is why they are not three
   * mechanisms.
   *
   * Only APPLIED plugins are torn down. A build that failed at plugin 3
   * leaves plugin 4 never having run, and calling its teardown would ask it
   * to release something it never acquired.
   *
   * Failure-tolerant throughout: a throwing teardown is logged and the
   * remaining teardowns still run, because the caller's original error is
   * what the operator needs and one plugin's cleanup must not strand
   * another's.
   *
   * @param partial - The context never finished starting.
   */
  private async teardownPlugins(partial: boolean): Promise<void> {
    for (let i = this.plugins.length - 1; i >= 0; i--) {
      if (!this.appliedPlugins.has(i)) continue;
      const plugin = this.plugins[i] as CraftPlugin | undefined;
      if (!plugin?.teardown) continue;
      const pluginId = this.getPluginId(plugin, i);

      this.emit("plugin:stopping", { pluginId, pluginIndex: i });

      try {
        await Promise.resolve(
          plugin.teardown(this, {
            partial,
            started: this.startedPlugins.has(i),
          }),
        );
        this.emit("plugin:stopped", { pluginId, pluginIndex: i });
      } catch (err) {
        this.logger.warn(
          { err, pluginIndex: i },
          "Plugin teardown threw; continuing with remaining teardowns.",
        );
      }
    }
    // LIFO: unwind registered teardowns in the opposite order they were
    // acquired, mirroring the reverse plugin teardown above.
    for (let i = this.teardownCallbacks.length - 1; i >= 0; i--) {
      try {
        await Promise.resolve(this.teardownCallbacks[i]());
      } catch (err) {
        this.logger.warn(
          { err },
          "Plugin teardown threw; continuing with remaining teardowns.",
        );
      }
    }
  }

  /**
   * Release everything a failed `build()` acquired, then let the caller
   * rethrow the original error.
   *
   * `build()` never returns a context when it fails, so the caller has no
   * handle to run teardown against: whatever an `apply()` opened (a database
   * handle, a socket, an interval) is unreachable and stays open. Under a
   * supervisor that retries boot, one handle leaks per attempt, and with
   * SQLite the held handle also keeps the file locked, so a transient boot
   * failure becomes a permanent one whose error names lock contention rather
   * than the real cause.
   *
   * @internal Called by `ContextBuilder.build()` on the failure path.
   */
  async unwindFailedBuild(): Promise<void> {
    this.hasStopped = true;
    await this.teardownPlugins(true);
  }

  private async performShutdown(): Promise<void> {
    this.logger.info({}, "Stopping Routecraft context");
    this.emit("context:stopping", { reason: undefined });

    // 1. Abort all route controllers (stops sources)
    for (const route of this.routes) {
      this.logger.info({ route: route.definition.id }, "Stopping route");
      const controller = this.controllers.get(route.definition.id);
      controller?.abort("context.stop()");
    }

    // 2. Drain all routes (wait for in-flight handlers + their tasks)
    let drainError: unknown;
    try {
      await Promise.all(this.routes.map((r) => r.drain()));
    } catch (err) {
      drainError = err;
      this.logger.warn(
        { err },
        "Route drain failed during stop(); continuing teardown.",
      );
    }

    // 3. Run plugin teardown (plugins with teardown in reverse order, then registerTeardown callbacks)
    await this.teardownPlugins(!this.startCompleted);

    this.logger.info({}, "Routecraft context stopped");
    this.emit("context:stopped", {});

    if (drainError) {
      throw drainError;
    }
  }
}
