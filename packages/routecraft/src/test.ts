import type { CraftContext } from "./context.ts";
import type { CraftConfig, StoreRegistry } from "./context.ts";
import { ContextBuilder } from "./builder.ts";
import { RouteCraftError, error as rcError } from "./error.ts";
import type { EventName, EventHandler } from "./types.ts";
import type { RouteDefinition } from "./route.ts";
import type { RouteBuilder } from "./builder.ts";

const DEFAULT_ROUTES_READY_TIMEOUT_MS = 200;

export interface TestContextOptions {
  /** Timeout in ms for waiting for all routes to emit routeStarted. Default 200. */
  routesReadyTimeoutMs?: number;
}

/**
 * Test-friendly wrapper around CraftContext. Runs the real context but manages
 * lifecycle (start → wait routes ready → drain → stop) and collects errors.
 */
export class TestContext {
  readonly ctx: CraftContext;
  readonly errors: RouteCraftError[] = [];
  private readonly routesReadyTimeoutMs: number;

  constructor(ctx: CraftContext, options?: TestContextOptions) {
    this.ctx = ctx;
    this.routesReadyTimeoutMs =
      options?.routesReadyTimeoutMs ?? DEFAULT_ROUTES_READY_TIMEOUT_MS;
    ctx.on("error", (payload) => {
      const err = payload.details.error;
      this.errors.push(
        err instanceof RouteCraftError ? err : rcError("RC9901", err),
      );
    });
  }

  /**
   * Start context, wait for all routes ready, drain in-flight, then stop.
   * Assert after this returns (mocks, t.errors, t.ctx.getStore() all valid).
   */
  async test(): Promise<void> {
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
      await ctx.drain();
    } finally {
      await ctx.stop();
      await started;
    }
  }

  drain(): Promise<void> {
    return this.ctx.drain();
  }

  stop(): Promise<void> {
    return this.ctx.stop();
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
    const ctx = await this.builder.build();
    const options: TestContextOptions | undefined =
      this.routesReadyTimeoutMs !== undefined
        ? { routesReadyTimeoutMs: this.routesReadyTimeoutMs }
        : undefined;
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
