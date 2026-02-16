import { describe, test, expect, afterEach, vi } from "vitest";
import {
  testContext,
  craft,
  simple,
  noop,
  type CraftContext,
  type CraftPlugin,
  type TestContext,
} from "@routecraft/routecraft";

describe("Plugin System", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verifies that plugins receive the context
   * @preconditions A plugin is registered in the config
   * @expectedResult Plugin is called with the context
   */
  test("Plugin receives context", async () => {
    const pluginMock = vi.fn<[CraftContext], void>();

    t = await testContext()
      .with({
        plugins: [pluginMock as CraftPlugin],
      })
      .build();

    expect(pluginMock).toHaveBeenCalledWith(t.ctx);
    expect(pluginMock).toHaveBeenCalledTimes(1);
  });

  /**
   * @case Verifies that multiple plugins run in order
   * @preconditions Multiple plugins are registered
   * @expectedResult Plugins execute in the order they were provided
   */
  test("Multiple plugins run in order", async () => {
    const callOrder: string[] = [];
    const plugin1 = vi.fn(() => callOrder.push("plugin1")) as CraftPlugin;
    const plugin2 = vi.fn(() => callOrder.push("plugin2")) as CraftPlugin;
    const plugin3 = vi.fn(() => callOrder.push("plugin3")) as CraftPlugin;

    t = await testContext()
      .with({
        plugins: [plugin1, plugin2, plugin3],
      })
      .build();

    expect(callOrder).toEqual(["plugin1", "plugin2", "plugin3"]);
  });

  /**
   * @case Verifies that plugins can subscribe to context events
   * @preconditions A plugin subscribes to a context event
   * @expectedResult Event handler is called when the event fires
   */
  test("Plugin can subscribe to context events", async () => {
    const eventMock = vi.fn();

    const plugin = (ctx: CraftContext) => {
      ctx.on("contextStarted", eventMock);
    };

    t = await testContext()
      .routes(craft().id("test").from(simple("hello")).to(noop()))
      .with({
        plugins: [plugin],
      })
      .build();

    const execution = t.ctx.start();

    // Allow time for events to process
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(eventMock).toHaveBeenCalled();

    await t.ctx.stop();
    await execution;
  });

  /**
   * @case Verifies that plugins can set up stores
   * @preconditions A plugin sets a value in the context store
   * @expectedResult Store value is accessible after plugin runs
   */
  test("Plugin can set up stores", async () => {
    const plugin = (ctx: CraftContext) => {
      ctx.setStore("test-plugin-key" as any, { data: "test" });
    };

    t = await testContext()
      .with({
        plugins: [plugin],
      })
      .build();

    const stored = t.ctx.getStore("test-plugin-key" as any);
    expect(stored).toEqual({ data: "test" });
  });

  /**
   * @case Verifies that plugins can dynamically register routes
   * @preconditions A plugin calls ctx.registerRoutes() during initialization
   * @expectedResult Routes registered by plugin are available
   */
  test("Plugin can dynamically register routes before routes are registered", async () => {
    const plugin = (ctx: CraftContext) => {
      // Plugin can add routes before the main routes are registered
      ctx.registerRoutes(
        craft()
          .id("plugin-added-route")
          .from(simple("from-plugin"))
          .to(noop())
          .build()[0],
      );
    };

    t = await testContext()
      .routes(craft().id("main-route").from(simple("main")).to(noop()))
      .with({
        plugins: [plugin],
      })
      .build();

    const routes = t.ctx.getRoutes();
    const pluginRoute = routes.find(
      (r) => r.definition.id === "plugin-added-route",
    );
    const mainRoute = routes.find((r) => r.definition.id === "main-route");

    expect(pluginRoute).toBeDefined();
    expect(mainRoute).toBeDefined();
    expect(routes.length).toBe(2);
  });

  /**
   * @case Verifies that plugins run before routes are registered and see zero routes during initialization
   * @preconditions A plugin reads ctx.getRoutes().length during its run
   * @expectedResult Plugin sees 0 routes during init; after build, context has 2 routes
   */
  test("Plugin runs before routes are registered and can access context", async () => {
    let routeCountInPlugin = 0;

    const plugin = (ctx: CraftContext) => {
      routeCountInPlugin = ctx.getRoutes().length;
    };

    t = await testContext()
      .routes([
        craft().id("route1").from(simple("a")).to(noop()),
        craft().id("route2").from(simple("b")).to(noop()),
      ])
      .with({
        plugins: [plugin],
      })
      .build();

    // Routes are registered after plugins, so plugin sees 0 routes during initialization
    expect(routeCountInPlugin).toBe(0);
    // But after build completes, routes are registered
    expect(t.ctx.getRoutes().length).toBe(2);
  });

  /**
   * @case Verifies that multiple plugins from config are combined
   * @preconditions Plugins are provided via both routes() and with()
   * @expectedResult All plugins run
   */
  test("Plugins from config execute", async () => {
    const plugin1 = vi.fn<[CraftContext], void>() as CraftPlugin;
    const plugin2 = vi.fn<[CraftContext], void>() as CraftPlugin;

    t = await testContext()
      .routes(craft().id("test").from(simple("hello")).to(noop()))
      .with({
        plugins: [plugin1, plugin2],
      })
      .build();

    expect(plugin1).toHaveBeenCalled();
    expect(plugin2).toHaveBeenCalled();
  });

  /**
   * @case Verifies that plugins can be added via both builder methods
   * @preconditions Plugins are registered at different times
   * @expectedResult Both sets of plugins execute
   */
  test("Plugins accumulate from multiple builder calls", async () => {
    const calls: string[] = [];
    const plugin1 = () => calls.push("plugin1");
    const plugin2 = () => calls.push("plugin2");

    t = await testContext()
      .with({
        plugins: [plugin1 as CraftPlugin],
      })
      .with({
        plugins: [plugin2 as CraftPlugin],
      })
      .build();

    expect(calls).toContain("plugin1");
    expect(calls).toContain("plugin2");
  });
});
