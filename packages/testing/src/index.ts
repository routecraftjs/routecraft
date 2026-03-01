import { readFileSync } from "node:fs";
import { vi, test } from "vitest";
import type {
  CraftContext,
  CraftConfig,
  StoreRegistry,
} from "@routecraft/routecraft";
import {
  ContextBuilder,
  DefaultExchange,
  isRouteCraftError,
  RouteCraftError,
  rcError,
  logger,
} from "@routecraft/routecraft";
import type {
  EventName,
  EventHandler,
  RouteDefinition,
  RouteBuilder,
  Destination,
  ExchangeHeaders,
} from "@routecraft/routecraft";

const DEFAULT_ROUTES_READY_TIMEOUT_MS = 200;

function createSpyLogger(): SpyLogger {
  const spy: SpyLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  spy.child.mockImplementation(() => spy);
  return spy;
}

function createNoopSpyLogger(): SpyLogger {
  const noop = vi.fn();
  const childFn = vi.fn();
  const noopLogger: SpyLogger = {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    trace: noop,
    fatal: noop,
    child: childFn,
  };
  childFn.mockImplementation(() => noopLogger);
  return noopLogger;
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
 * Spy logger with vi.fn() methods for assertions (e.g. expect(t.logger.info).toHaveBeenCalledWith(...)).
 */
export type SpyLogger = {
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof vi.fn>;
  fatal: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
};

/**
 * Test-friendly wrapper around CraftContext. Runs the real context but manages
 * lifecycle (start → wait routes ready → drain → stop) and collects errors.
 * t.logger is a spy logger (vi.fn() methods) for asserting on log calls.
 */
export class TestContext {
  readonly ctx: CraftContext;
  /** Spy logger; e.g. expect(t.logger.info).toHaveBeenCalledWith(...) */
  readonly logger: SpyLogger;
  readonly errors: RouteCraftError[] = [];
  private readonly routesReadyTimeoutMs: number;

  private restoreLoggerChild?: () => void;
  private startedPromise?: Promise<void>;

  constructor(
    ctx: CraftContext,
    options?: TestContextOptions & {
      spyLogger?: SpyLogger;
      restoreLoggerChild?: () => void;
    },
  ) {
    this.ctx = ctx;
    this.logger = options?.spyLogger ?? createNoopSpyLogger();
    if (options?.restoreLoggerChild)
      this.restoreLoggerChild = options.restoreLoggerChild;
    this.routesReadyTimeoutMs =
      options?.routesReadyTimeoutMs ?? DEFAULT_ROUTES_READY_TIMEOUT_MS;
    ctx.on("error", (payload) => {
      const err = payload.details.error;
      this.errors.push(
        isRouteCraftError(err)
          ? (err as RouteCraftError)
          : rcError("RC9901", err),
      );
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

            const offRouteStarted = ctx.on("routeStarted", () => {
              if (settled) return;
              ready++;
              if (ready >= total) {
                settled = true;
                clearTimeout(timeoutId);
                offRouteStarted();
                offError();
                resolve();
              }
            });
            const offError = ctx.on("error", (payload) => {
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

            const offRouteStarted = ctx.on("routeStarted", () => {
              if (settled) return;
              ready++;
              if (ready >= total) {
                cleanup();
                resolve();
              }
            });
            const offError = ctx.on("error", (payload) => {
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
        this.restoreLoggerChild?.();
      }
    }
  }

  drain(): Promise<void> {
    return this.ctx.drain();
  }

  async stop(): Promise<void> {
    await this.ctx.stop();
    if (this.startedPromise !== undefined) {
      await this.startedPromise;
    }
  }
}

/**
 * Builder that returns TestContext instead of CraftContext.
 * Same API as ContextBuilder (routes, on, with, store).
 */
export class TestContextBuilder {
  private builder = new ContextBuilder();
  private routesReadyTimeoutMs: number | undefined;

  /** Override timeout for waiting for routes to start (ms). Used by tests that assert timeout behavior. */
  routesReadyTimeout(ms: number): this {
    this.routesReadyTimeoutMs = ms;
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
    const ctx = await this.builder.build();
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
    return new TestContext(ctx, options);
  }
}

/**
 * Create a test context builder. Use .routes(...).build(), await the result, then await t.test().
 *
 * @example
 * const builder = testContext();
 * const t = await builder.routes(myRoutes).build();
 * await t.test();
 */
export function testContext(): TestContextBuilder {
  return new TestContextBuilder();
}

/** Duck-type: object with send(exchange) returning Promise. */
function isDestination(obj: unknown): obj is Destination<unknown, unknown> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as { send?: unknown }).send === "function"
  );
}

/**
 * Invoke a route by id or send to a destination and return the result.
 *
 * - **By route id:** Pass a string. The route is looked up with ctx.getRouteById(routeId).
 *   The route's source must implement Destination (e.g. DirectAdapter). Works with multiple
 *   routes in the default export — use the route's id.
 *
 * - **By destination:** Pass a Destination instance (e.g. direct("endpoint")). Builds an
 *   exchange and calls destination.send(exchange).
 *
 * @param ctx CraftContext (e.g. t.ctx from TestContext) with routes started
 * @param routeIdOrDestination Route id string or a Destination adapter instance
 * @param body Request body
 * @param headers Optional headers for the exchange
 * @returns The result from the route or destination (e.g. response body for DirectAdapter)
 */
export async function invoke<T = unknown, R = T>(
  ctx: CraftContext,
  routeIdOrDestination: string | Destination<T, R>,
  body: T,
  headers?: ExchangeHeaders,
): Promise<R> {
  const exchange = new DefaultExchange(ctx, {
    body,
    ...(headers !== undefined && { headers }),
  });
  let dest: Destination<T, R>;

  if (typeof routeIdOrDestination === "string") {
    const route = ctx.getRouteById(routeIdOrDestination);
    if (!route) {
      throw new Error(
        `No route with id "${routeIdOrDestination}". Did you start the context (e.g. await t.test())?`,
      );
    }
    const source = route.definition.source;
    if (!isDestination(source)) {
      throw new Error(
        `Route "${routeIdOrDestination}" is not invokable: source must implement Destination (e.g. direct adapter).`,
      );
    }
    dest = source as Destination<T, R>;
  } else {
    dest = routeIdOrDestination;
  }

  const result = await dest.send(exchange as Parameters<typeof dest.send>[0]);
  return result as R;
}

/**
 * Load a JSON fixture file and return the parsed value.
 *
 * @param path Absolute or relative path to the JSON file
 * @returns Parsed JSON as T
 */
export function fixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/** Fixture entry must have a `name` field used as the vitest test name. */
export interface FixtureWithName {
  name: string;
  [key: string]: unknown;
}

/**
 * Load a JSON array fixture and run one vitest test per entry. Each entry must have a `name` field (used as the test name).
 *
 * @param path Path to a JSON file that parses to an array
 * @param run Callback invoked per entry; use for assertions. Receives the fixture entry.
 */
export function fixtureEach<T extends FixtureWithName>(
  path: string,
  run: (entry: T) => void | Promise<void>,
): void {
  const entries = fixture<T[]>(path);
  if (!Array.isArray(entries)) {
    throw new Error(
      `fixture.each: expected JSON array at "${path}", got ${typeof entries}`,
    );
  }
  for (const entry of entries) {
    if (typeof entry?.name !== "string") {
      throw new Error(
        `fixture.each: each entry must have a "name" field (string). Got: ${JSON.stringify(entry)}`,
      );
    }
    test(entry.name, () => run(entry));
  }
}
