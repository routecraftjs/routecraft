import type {
  CraftContext,
  CraftConfig,
  StoreRegistry,
  EventName,
  EventHandler,
  RouteDefinition,
  AnyRouteBuilder,
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
import type { SpyFactory, SpyLogger } from "./spy-logger";
import {
  createSpyFn,
  createSpyLogger,
  createNoopSpyLogger,
} from "./spy-logger";
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
  /**
   * Mock factory used to build the spy logger. Defaults to the built-in
   * runner-agnostic spy. Pass your runner's factory (`vi.fn` from Vitest, or
   * `mock` from bun:test) to get native mocks that work with the runner's
   * `expect` matchers, e.g. `testContext({ fn: vi.fn })`.
   */
  fn?: SpyFactory;
}

/**
 * Options for TestContext.test().
 */
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
 * t.logger is a spy logger for asserting on log calls.
 */
export class TestContext {
  readonly ctx: CraftContext;
  /** Client for dispatching messages to direct endpoints in tests. */
  readonly client: CraftClient;
  /** Spy logger; e.g. t.logger.info.mock.calls, or expect(t.logger.info).toHaveBeenCalledWith(...) with an injected runner mock factory */
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
   * Build a promise that resolves once every route has emitted
   * `route:started`, or rejects on `context:error` or the configured
   * routes-ready timeout. Shared by {@link startAndWaitReady} and {@link test}.
   */
  private awaitRoutesReady(): Promise<void> {
    const ctx = this.ctx;
    const total = ctx.getRoutes().length;
    if (total === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let ready = 0;
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
        () => {
          if (settled) return;
          cleanup();
          reject(new Error("Timeout waiting for routes to start"));
        },
        this.routesReadyTimeoutMs,
      );

      const offRouteStarted = ctx.on("route:started", (() => {
        if (settled) return;
        ready++;
        if (ready >= total) {
          cleanup();
          resolve();
        }
      }) as EventHandler<EventName>);
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
  }

  /**
   * Start context and resolve once every route has emitted `route:started`.
   * Does not drain or stop. Does not await `ctx.start()` completion, which
   * lets this method work with long-running sources (direct, mcp, HTTP, etc.)
   * whose subscribe blocks until the route is aborted. The start promise is
   * stored internally and awaited by {@link stop} for clean shutdown.
   *
   * Use with {@link CraftClient.send} (via `t.client`) for direct endpoints,
   * or drive sources directly via the context store, then call `drain()` /
   * `stop()` when done.
   *
   * If `ctx.start()` rejects (synchronously or before any route emits
   * `route:started`), the rejection surfaces here via the
   * `context:error` listener installed by `awaitRoutesReady`. A no-op
   * catch is attached to `startedPromise` as a safety net so that a
   * slow rejection does not trigger an `unhandledRejection` before
   * `stop()` awaits the promise for teardown.
   */
  async startAndWaitReady(): Promise<void> {
    const allReady = this.awaitRoutesReady();
    this.startedPromise = this.ctx.start();
    // Attach a no-op handler so Node does not report the rejection as
    // unhandled before `stop()` re-awaits the promise.
    this.startedPromise.catch(() => {});
    await allReady;
  }

  /**
   * Start context, wait for all routes ready, optionally delay, drain in-flight, then stop.
   * Assert after this returns (mocks, t.errors, t.ctx.getStore() all valid).
   *
   * @param options.delayBeforeDrainMs If set, wait this many ms after routes are ready before draining.
   *   Use for timer (or other deferred) sources so at least one message is processed before drain/stop.
   */
  async test(options?: TestOptions): Promise<void> {
    const ctx = this.ctx;
    const allReady = this.awaitRoutesReady();
    const started = ctx.start();
    // Shield a synchronous rejection of `started` from becoming an
    // unhandled rejection before the `finally` block re-awaits it.
    started.catch(() => {});
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
 */
export class TestContextBuilder {
  private builder = new ContextBuilder();
  private routesReadyTimeoutMs: number | undefined;
  private adapterOverrides: AdapterOverride[] = [];
  private readonly spyFactory: SpyFactory;

  constructor(options?: TestContextOptions) {
    this.spyFactory = options?.fn ?? createSpyFn;
    this.routesReadyTimeoutMs = options?.routesReadyTimeoutMs;
  }

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
      | AnyRouteBuilder[]
      | RouteDefinition
      | AnyRouteBuilder,
  ): this {
    this.builder.routes(routes);
    return this;
  }

  async build(): Promise<TestContext> {
    const spyLogger = createSpyLogger(this.spyFactory);
    const originalChild = logger.child.bind(logger);
    const childSpy = this.spyFactory();
    childSpy.mockImplementation(
      () => spyLogger as unknown as ReturnType<typeof logger.child>,
    );
    logger.child = childSpy as unknown as typeof logger.child;
    // Restore the patched child on build failure: the restore hook is only
    // handed to TestContext after a successful build, so without this a
    // rejected build (e.g. an invalid route) would leak the stub into every
    // later test in the process.
    let built: Awaited<ReturnType<ContextBuilder["build"]>>;
    try {
      built = await this.builder.build();
    } catch (error) {
      logger.child = originalChild;
      throw error;
    }
    const { context: ctx, client } = built;

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
 * Runner-agnostic by default: the spy logger uses a built-in spy that records
 * calls in the jest-compatible `mock.calls` shape. Pass `{ fn }` with your
 * runner's mock factory (`vi.fn` from Vitest, `mock` from bun:test) when you
 * want `expect(t.logger.info).toHaveBeenCalledWith(...)` matcher support.
 *
 * @example
 * const builder = testContext();
 * const t = await builder.routes(myRoutes).build();
 * await t.test();
 *
 * @example
 * // Vitest, with native matcher support:
 * const t = await testContext({ fn: vi.fn }).routes(myRoutes).build();
 */
export function testContext(options?: TestContextOptions): TestContextBuilder {
  return new TestContextBuilder(options);
}
