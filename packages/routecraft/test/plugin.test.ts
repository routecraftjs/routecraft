import { describe, test, expect, afterEach, vi } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  noop,
  type CraftContext,
  type CraftPlugin,
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
    const applyMock = vi.fn<[CraftContext], void>();

    t = await testContext()
      .with({
        plugins: [{ apply: applyMock }],
      })
      .build();

    expect(applyMock).toHaveBeenCalledWith(t.ctx);
    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  /**
   * @case Verifies that multiple plugins run in order
   * @preconditions Multiple plugins are registered
   * @expectedResult Plugins execute in the order they were provided
   */
  test("Multiple plugins run in order", async () => {
    const callOrder: string[] = [];
    const plugin1: CraftPlugin = {
      apply: () => callOrder.push("plugin1"),
    };
    const plugin2: CraftPlugin = {
      apply: () => callOrder.push("plugin2"),
    };
    const plugin3: CraftPlugin = {
      apply: () => callOrder.push("plugin3"),
    };

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

    const plugin: CraftPlugin = {
      apply(ctx: CraftContext) {
        ctx.on("context:started", eventMock);
      },
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
    const plugin: CraftPlugin = {
      apply(ctx: CraftContext) {
        ctx.setStore("test-plugin-key" as any, { data: "test" });
      },
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
    const plugin: CraftPlugin = {
      apply(ctx: CraftContext) {
        ctx.registerRoutes(
          craft()
            .id("plugin-added-route")
            .from(simple("from-plugin"))
            .to(noop())
            .build()[0],
        );
      },
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

    const plugin: CraftPlugin = {
      apply(ctx: CraftContext) {
        routeCountInPlugin = ctx.getRoutes().length;
      },
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
    const apply1 = vi.fn<[CraftContext], void>();
    const apply2 = vi.fn<[CraftContext], void>();

    t = await testContext()
      .routes(craft().id("test").from(simple("hello")).to(noop()))
      .with({
        plugins: [{ apply: apply1 }, { apply: apply2 }],
      })
      .build();

    expect(apply1).toHaveBeenCalled();
    expect(apply2).toHaveBeenCalled();
  });

  /**
   * @case Verifies that plugins can be added via both builder methods
   * @preconditions Plugins are registered at different times
   * @expectedResult Both sets of plugins execute
   */
  test("Plugins accumulate from multiple builder calls", async () => {
    const calls: string[] = [];
    const plugin1: CraftPlugin = {
      apply: () => calls.push("plugin1"),
    };
    const plugin2: CraftPlugin = {
      apply: () => calls.push("plugin2"),
    };

    t = await testContext()
      .with({
        plugins: [plugin1],
      })
      .with({
        plugins: [plugin2],
      })
      .build();

    expect(calls).toContain("plugin1");
    expect(calls).toContain("plugin2");
  });

  /**
   * @case Verifies that plugin lifecycle events are emitted during teardown
   * @preconditions A plugin is registered with a teardown method
   * @expectedResult stopping and stopped lifecycle events are emitted when context stops
   */
  test("Plugin lifecycle events are emitted", async () => {
    let stoppingCalled = false;
    let stoppedCalled = false;
    let teardownCalled = false;

    const plugin: CraftPlugin = {
      apply() {
        // Plugin initialization
      },
      teardown() {
        teardownCalled = true;
      },
    };

    t = await testContext()
      .with({
        plugins: [plugin],
      })
      .build();

    // Subscribe to plugin lifecycle events (plugin ID is "plugin-0" for plain object at index 0)
    t.ctx.on("plugin:plugin-0:stopping", () => {
      stoppingCalled = true;
    });

    t.ctx.on("plugin:plugin-0:stopped", () => {
      stoppedCalled = true;
    });

    // Stop to trigger teardown events
    await t.ctx.stop();

    // Verify teardown was called and events were emitted
    expect(teardownCalled).toBe(true);
    expect(stoppingCalled).toBe(true);
    expect(stoppedCalled).toBe(true);
  });

  /**
   * @case Verifies plugin lifecycle events include correct metadata
   * @preconditions A named plugin is registered
   * @expectedResult Events contain pluginId and pluginIndex
   */
  test("Plugin lifecycle events include metadata", async () => {
    const capturedEvents: Array<{ pluginId: string; pluginIndex: number }> = [];

    class MyTestPlugin implements CraftPlugin {
      apply() {
        // Plugin initialization
      }
      teardown() {
        // Plugin cleanup
      }
    }

    const plugin = new MyTestPlugin();

    t = await testContext()
      .with({
        plugins: [plugin],
      })
      .build();

    // Subscribe to plugin lifecycle events (pattern must match 3 segments: plugin:ID:event)
    t.ctx.on("plugin:*:*", (payload) => {
      const details = payload.details as {
        pluginId: string;
        pluginIndex: number;
      };
      capturedEvents.push({
        pluginId: details.pluginId,
        pluginIndex: details.pluginIndex,
      });
    });

    // Stop to trigger teardown events (which we can capture)
    await t.ctx.stop();

    // Should have captured stopping and stopped events
    expect(capturedEvents.length).toBe(2);
    expect(capturedEvents[0].pluginId).toBe("MyTestPlugin");
    expect(capturedEvents[0].pluginIndex).toBe(0);
    expect(capturedEvents[1].pluginId).toBe("MyTestPlugin");
    expect(capturedEvents[1].pluginIndex).toBe(0);
  });
});
