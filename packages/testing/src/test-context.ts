import { vi } from "vitest";
import type {
  CraftContext,
  CraftConfig,
  StoreRegistry,
  EventName,
  EventHandler,
  RouteDefinition,
  RouteBuilder,
  AdapterOverride,
} from "@routecraft/routecraft";
import {
  ContextBuilder,
  CraftClient,
  isRoutecraftError,
  RoutecraftError,
  rcError,
  logger,
  RC_ADAPTER_OVERRIDES,
} from "@routecraft/routecraft";
import type { SpyLogger } from "./spy-logger";
import { createSpyLogger, createNoopSpyLogger } from "./spy-logger";
import { isAdapterMock, type AdapterMock } from "./mock-adapter";

const DEFAULT_ROUTES_READY_TIMEOUT_MS = 200;

function describeOverrideTarget(target: unknown): string {
  if (typeof target === "function" && typeof target.name === "string") {
    const kind =
      /^[A-Z]/.test(target.name) && target.prototype !== undefined
        ? "class"
        : "factory";
    return `${kind} ${target.name || "<anonymous>"}`;
  }
  return "target";
}

export interface TestContextOptions {
  /** Timeout in ms for waiting for all routes to emit routeStarted. Default 200. */
  routesReadyTimeoutMs?: number;
}

/** Options for TestContext.test(). */
export interface TestOptions {
  /**
   * Delay in ms after all routes are ready, before draining.
   * Use for timer (or other deferred) sources so at least one message is processed before drain/stop.
   * E.g. `await t.test({ delayBeforeDrainMs: 50 })` for a timer with intervalMs >= 50.
   */
  delayBeforeDrainMs?: number;
}

/**
 * Test-friendly wrapper around CraftContext. Runs the real context but manages
 * lifecycle (start, wait routes ready, drain, stop) and collects errors.
 * t.logger is a spy logger (vi.fn() methods) for asserting on log calls.
 *
 * @beta
 */
export class TestContext {
  readonly ctx: CraftContext;
  /** Client for dispatching messages to direct endpoints in tests. */
  readonly client: CraftClient;
  /** Spy logger; e.g. expect(t.logger.info).toHaveBeenCalledWith(...) */
  readonly logger: SpyLogger;
  readonly errors: RoutecraftError[] = [];
  private readonly routesReadyTimeoutMs: number;

  private restoreLoggerChild?: () => void;
  private loggerChildRestored = false;
  private startedPromise?: Promise<void>;

  constructor(
    ctx: CraftContext,
    client: CraftClient,
    options?: TestContextOptions & {
      spyLogger?: SpyLogger;
      restoreLoggerChild?: () => void;
    },
  ) {
    this.ctx = ctx;
    this.client = client;
    this.logger = options?.spyLogger ?? createNoopSpyLogger();
    if (options?.restoreLoggerChild)
      this.restoreLoggerChild = options.restoreLoggerChild;
    this.routesReadyTimeoutMs =
      options?.routesReadyTimeoutMs ?? DEFAULT_ROUTES_READY_TIMEOUT_MS;
    const pushError = (err: unknown) => {
      this.errors.push(
        isRoutecraftError(err)
          ? (err as RoutecraftError)
          : rcError("RC9901", err),
      );
    };
    ctx.on("context:error", (payload) => {
      pushError(payload.details.error);
    });
  }

  /**
   * Start context and wait for all routes to be ready. Does not drain or stop.
   * Use with invoke() to send to a route by id, then call drain()/stop() when done.
   */
  async startAndWaitReady(): Promise<void> {
    const ctx = this.ctx;
    const total = ctx.getRoutes().length;
    const allReady =
      total === 0
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            let ready = 0;
            let settled = false;
            const timeoutId = setTimeout(() => {
              if (settled) return;
              settled = true;
              offRouteStarted();
              offError();
              reject(new Error("Timeout waiting for routes to start"));
            }, this.routesReadyTimeoutMs);

            const offRouteStarted = ctx.on(
              "route:*:started" as EventName,
              (() => {
                if (settled) return;
                ready++;
                if (ready >= total) {
                  settled = true;
                  clearTimeout(timeoutId);
                  offRouteStarted();
                  offError();
                  resolve();
                }
              }) as EventHandler<EventName>,
            );
            const offError = ctx.on("context:error", (payload) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeoutId);
              offRouteStarted();
              offError();
              reject(payload.details.error);
            });
          });
    this.startedPromise = ctx.start();
    await Promise.all([this.startedPromise, allReady]);
  }

  /**
   * Start context, wait for all routes ready, optionally delay, drain in-flight, then stop.
   * Assert after this returns (mocks, t.errors, t.ctx.getStore() all valid).
   *
   * @param options.delayBeforeDrainMs — If set, wait this many ms after routes are ready before draining.
   *   Use for timer (or other deferred) sources so at least one message is processed before drain/stop.
   */
  async test(options?: TestOptions): Promise<void> {
    const ctx = this.ctx;
    const total = ctx.getRoutes().length;
    const allReady =
      total === 0
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            let ready = 0;
            let settled = false;
            let timeoutId: ReturnType<typeof setTimeout> | undefined =
              setTimeout(() => {
                if (settled) return;
                cleanup();
                reject(new Error("Timeout waiting for routes to start"));
              }, this.routesReadyTimeoutMs);

            const offRouteStarted = ctx.on(
              "route:*:started" as EventName,
              (() => {
                if (settled) return;
                ready++;
                if (ready >= total) {
                  cleanup();
                  resolve();
                }
              }) as EventHandler<EventName>,
            );
            const offError = ctx.on("context:error", (payload) => {
              if (settled) return;
              cleanup();
              reject(payload.details.error);
            });

            function cleanup(): void {
              if (settled) return;
              settled = true;
              offRouteStarted();
              offError();
              if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
                timeoutId = undefined;
              }
            }
          });
    const started = ctx.start();
    try {
      await allReady;
      const delayMs = options?.delayBeforeDrainMs ?? 0;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      await ctx.drain();
    } finally {
      try {
        await ctx.stop();
        await started;
      } finally {
        this.restoreLoggerChildOnce();
      }
    }
  }

  drain(): Promise<void> {
    return this.ctx.drain();
  }

  async stop(): Promise<void> {
    try {
      await this.ctx.stop();
      if (this.startedPromise !== undefined) {
        await this.startedPromise;
      }
    } finally {
      this.restoreLoggerChildOnce();
    }
  }

  private restoreLoggerChildOnce(): void {
    if (this.loggerChildRestored) return;
    this.restoreLoggerChild?.();
    this.loggerChildRestored = true;
  }
}

/**
 * Builder that returns TestContext instead of CraftContext.
 * Same API as ContextBuilder (routes, on, with, store).
 *
 * @beta
 */
export class TestContextBuilder {
  private builder = new ContextBuilder();
  private routesReadyTimeoutMs: number | undefined;
  private adapterOverrides: AdapterOverride[] = [];

  /** Override timeout for waiting for routes to start (ms). Used by tests that assert timeout behavior. */
  routesReadyTimeout(ms: number): this {
    this.routesReadyTimeoutMs = ms;
    return this;
  }

  /**
   * Register an adapter mock. At route execution time, calls to adapters
   * produced by the same factory are routed through the mock's handlers
   * instead of invoking the real adapter. Accepts either the handle returned
   * by `mockAdapter()` or a raw `AdapterOverride`.
   *
   * @experimental
   */
  override(mock: AdapterMock | AdapterOverride): this {
    const entry: AdapterOverride = isAdapterMock(mock) ? mock.override : mock;
    // Fail fast if two overrides target the same factory/class. The framework
    // uses first-match semantics at execution time, so silently accepting a
    // duplicate would mean the second mock's assertions always see zero calls
    // and the user has no signal that their new override is being shadowed.
    const duplicate = this.adapterOverrides.find(
      (o) => o.target === entry.target,
    );
    if (duplicate !== undefined) {
      const name = describeOverrideTarget(entry.target);
      throw new Error(
        `testContext().override(): duplicate override for ${name}. Each target may only be registered once; remove the redundant override() call.`,
      );
    }
    this.adapterOverrides.push(entry);
    return this;
  }

  with(config: CraftConfig): this {
    this.builder.with(config);
    return this;
  }

  on<K extends EventName>(event: K, handler: EventHandler<K>): this {
    this.builder.on(event, handler);
    return this;
  }

  once<K extends EventName>(event: K, handler: EventHandler<K>): this {
    this.builder.once(event, handler);
    return this;
  }

  store<K extends keyof StoreRegistry>(key: K, value: StoreRegistry[K]): this {
    this.builder.store(key, value);
    return this;
  }

  routes(
    routes:
      | RouteDefinition[]
      | RouteBuilder<unknown>[]
      | RouteDefinition
      | RouteBuilder<unknown>,
  ): this {
    this.builder.routes(routes);
    return this;
  }

  async build(): Promise<TestContext> {
    const spyLogger = createSpyLogger();
    const originalChild = logger.child.bind(logger);
    logger.child = vi.fn(
      () => spyLogger as unknown as ReturnType<typeof logger.child>,
    ) as typeof logger.child;
    const { context: ctx, client } = await this.builder.build();

    // Install registered adapter overrides onto the context store so that
    // ToStep / EnrichStep / Route source can resolve them at execution time.
    if (this.adapterOverrides.length > 0) {
      const existing = ctx.getStore(RC_ADAPTER_OVERRIDES) ?? [];
      ctx.setStore(RC_ADAPTER_OVERRIDES, [
        ...existing,
        ...this.adapterOverrides,
      ]);
    }

    const options: TestContextOptions & {
      spyLogger: SpyLogger;
      restoreLoggerChild: () => void;
    } = {
      ...(this.routesReadyTimeoutMs !== undefined
        ? { routesReadyTimeoutMs: this.routesReadyTimeoutMs }
        : {}),
      spyLogger,
      restoreLoggerChild: () => {
        logger.child = originalChild;
      },
    };
    return new TestContext(ctx, client, options);
  }
}

/**
 * Create a test context builder. Use .routes(...).build(), await the result, then await t.test().
 *
 * @beta
 * @example
 * const builder = testContext();
 * const t = await builder.routes(myRoutes).build();
 * await t.test();
 */
export function testContext(): TestContextBuilder {
  return new TestContextBuilder();
}
