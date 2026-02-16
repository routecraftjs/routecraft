import type { CraftContext } from "./context.ts";
import type { CraftConfig, StoreRegistry } from "./context.ts";
import { ContextBuilder } from "./builder.ts";
import { RouteCraftError, error as rcError } from "./error.ts";
import type { EventName, EventHandler } from "./types.ts";
import type { RouteDefinition } from "./route.ts";
import type { RouteBuilder } from "./builder.ts";

const ROUTES_READY_TIMEOUT_MS = 10_000;

/**
 * Test-friendly wrapper around CraftContext. Runs the real context but manages
 * lifecycle (start → wait routes ready → drain → stop) and collects errors.
 */
export class TestContext {
  readonly ctx: CraftContext;
  readonly errors: RouteCraftError[] = [];

  constructor(ctx: CraftContext) {
    this.ctx = ctx;
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
              }, ROUTES_READY_TIMEOUT_MS);

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
    await allReady;
    await ctx.drain();
    await ctx.stop();
    await started;
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
    return new TestContext(await this.builder.build());
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
