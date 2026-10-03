import { afterEach, describe, expect, mock, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  port,
  craft,
  simple,
  noop,
  type Plugin,
  type PluginContext,
} from "@routecraft/routecraft";
import { defaultPluginsFor } from "../src/kernel/defaults.ts";

describe("Plugin System", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verifies that a plugin's bind receives a plugin context bound to the application
   * @preconditions A plugin with an id is registered in the config
   * @expectedResult bind is called once with a plugin context carrying the plugin's id, and the context never exposes the CraftContext
   */
  test("Plugin receives context", async () => {
    const bindMock = mock<(c: PluginContext) => void>();

    t = await testContext()
      .with({
        plugins: [{ id: "test.receiver", bind: bindMock }],
      })
      .build();

    expect(bindMock).toHaveBeenCalledTimes(1);
    const received = bindMock.mock.calls[0][0];
    expect(received.id).toBe("test.receiver");
    expect("context" in received).toBe(false);
  });

  /**
   * @case Verifies that multiple plugins run in order
   * @preconditions Multiple plugins are registered
   * @expectedResult Plugins execute in the order they were provided
   */
  test("Multiple plugins run in order", async () => {
    const callOrder: string[] = [];
    const plugin1: Plugin = {
      id: "test.plugin1",
      bind: () => {
        callOrder.push("plugin1");
      },
    };
    const plugin2: Plugin = {
      id: "test.plugin2",
      bind: () => {
        callOrder.push("plugin2");
      },
    };
    const plugin3: Plugin = {
      id: "test.plugin3",
      bind: () => {
        callOrder.push("plugin3");
      },
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
    const eventMock = mock();

    const plugin: Plugin = {
      id: "test.plugin",
      bind(c) {
        c.observe("context:started", eventMock);
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
   * @case Verifies that a plugin shares state through a port it provides
   * @preconditions A plugin declares and provides a port in bind
   * @expectedResult The application resolves the port to the provided value
   */
  test("Plugin can provide a port", async () => {
    const SHARED = port<{ data: string }>("test.shared@1");
    const plugin: Plugin = {
      id: "test.plugin",
      provides: [SHARED],
      bind(c) {
        c.provide(SHARED, { data: "test" });
      },
    };

    t = await testContext()
      .with({
        plugins: [plugin],
      })
      .build();

    expect(t.ctx.lookup(SHARED)).toEqual({ data: "test" });
  });

  /**
   * @case Verifies that plugins can dynamically register routes
   * @preconditions A plugin calls c.routes.register() during bind
   * @expectedResult Routes registered by plugin are available
   */
  test("Plugin can dynamically register routes before routes are registered", async () => {
    const plugin: Plugin = {
      id: "test.plugin",
      bind(c) {
        c.routes.register(
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
   * @preconditions A plugin reads c.routes.list().length during bind
   * @expectedResult Plugin sees 0 routes during init; after build, context has 2 routes
   */
  test("Plugin runs before routes are registered and can access context", async () => {
    let routeCountInPlugin = 0;

    const plugin: Plugin = {
      id: "test.plugin",
      bind(c) {
        routeCountInPlugin = c.routes.list().length;
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
    const bind1 = mock<(c: PluginContext) => void>();
    const bind2 = mock<(c: PluginContext) => void>();

    t = await testContext()
      .routes(craft().id("test").from(simple("hello")).to(noop()))
      .with({
        plugins: [
          { id: "test.first", bind: bind1 },
          { id: "test.second", bind: bind2 },
        ],
      })
      .build();

    expect(bind1).toHaveBeenCalled();
    expect(bind2).toHaveBeenCalled();
  });

  /**
   * @case Verifies that plugins can be added via both builder methods
   * @preconditions Plugins are registered at different times
   * @expectedResult Both sets of plugins execute
   */
  test("Plugins accumulate from multiple builder calls", async () => {
    const calls: string[] = [];
    const plugin1: Plugin = {
      id: "test.plugin1",
      bind: () => {
        calls.push("plugin1");
      },
    };
    const plugin2: Plugin = {
      id: "test.plugin2",
      bind: () => {
        calls.push("plugin2");
      },
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
   * @case Verifies that plugin lifecycle events are emitted during stop
   * @preconditions A plugin is registered with a stop method
   * @expectedResult stopping and stopped lifecycle events are emitted when context stops
   */
  test("Plugin lifecycle events are emitted", async () => {
    let stoppingCalled = false;
    let stoppedCalled = false;
    let stopCalled = false;

    const plugin: Plugin = {
      id: "test.lifecycle",
      stop() {
        stopCalled = true;
      },
    };

    t = await testContext()
      .with({
        plugins: [plugin],
      })
      .build();

    t.ctx.on("plugin:stopping", () => {
      stoppingCalled = true;
    });

    t.ctx.on("plugin:stopped", () => {
      stoppedCalled = true;
    });

    await t.ctx.stop();

    expect(stopCalled).toBe(true);
    expect(stoppingCalled).toBe(true);
    expect(stoppedCalled).toBe(true);
  });

  /**
   * @case Verifies plugin lifecycle events include correct metadata
   * @preconditions A plugin with id "test.metadata" is registered
   * @expectedResult plugin:stopping and plugin:stopped carry the plugin's id as pluginId and its position in dependency order, after the default plugins installed ahead of it, as pluginIndex
   */
  test("Plugin lifecycle events include metadata", async () => {
    const capturedEvents: Array<{ pluginId: string; pluginIndex: number }> = [];

    const plugin: Plugin = {
      id: "test.metadata",
      stop() {},
    };

    t = await testContext()
      .with({
        plugins: [plugin],
      })
      .build();

    for (const name of ["plugin:stopping", "plugin:stopped"] as const) {
      t.ctx.on(name, (payload) => {
        const details = payload.details as {
          pluginId: string;
          pluginIndex: number;
        };
        capturedEvents.push({
          pluginId: details.pluginId,
          pluginIndex: details.pluginIndex,
        });
      });
    }

    await t.ctx.stop();

    expect(capturedEvents.length).toBe(2);
    const installedAt = defaultPluginsFor([plugin]).length;
    expect(capturedEvents[0].pluginId).toBe("test.metadata");
    expect(capturedEvents[0].pluginIndex).toBe(installedAt);
    expect(capturedEvents[1].pluginId).toBe("test.metadata");
    expect(capturedEvents[1].pluginIndex).toBe(installedAt);
  });

  /**
   * @case The plugin's id is the pluginId on bind lifecycle event payloads
   * @preconditions Plugin with id "test.my-plugin" registered; context built
   *                (initPlugins runs)
   * @expectedResult plugin:binding and plugin:bound carry pluginId "test.my-plugin"
   */
  test("plugin id is used as pluginId on lifecycle events", async () => {
    const seen: { event: string; pluginId: string }[] = [];
    const plugin: Plugin = {
      id: "test.my-plugin",
      bind: () => {},
    };

    t = await testContext()
      .on("plugin:binding", ({ details }) => {
        seen.push({ event: "binding", pluginId: details.pluginId });
      })
      .on("plugin:bound", ({ details }) => {
        seen.push({ event: "bound", pluginId: details.pluginId });
      })
      .with({ plugins: [plugin] })
      .build();

    expect(seen.filter((e) => e.pluginId === "test.my-plugin")).toEqual([
      { event: "binding", pluginId: "test.my-plugin" },
      { event: "bound", pluginId: "test.my-plugin" },
    ]);
  });

  /**
   * @case The framework's positions are filled by default plugins, and an application's plugin with the same id takes a default's place
   * @preconditions One context with no plugins; one context installing a plugin with the id "routecraft.cache"
   * @expectedResult The first binds routecraft.resilience, routecraft.cache and routecraft.auth; the second binds its own routecraft.cache once and no default one
   */
  test("default plugins install unless the application installs the same id", async () => {
    const bound: string[] = [];
    t = await testContext()
      .on("plugin:bound", ({ details }) => {
        bound.push(details.pluginId);
      })
      .build();
    expect(bound).toEqual(
      expect.arrayContaining([
        "routecraft.resilience",
        "routecraft.cache",
        "routecraft.auth",
      ]),
    );
    await t.stop();

    const overridden: string[] = [];
    let ownBound = false;
    t = await testContext()
      .on("plugin:bound", ({ details }) => {
        overridden.push(details.pluginId);
      })
      .with({
        plugins: [
          {
            id: "routecraft.cache",
            bind: () => {
              ownBound = true;
            },
          },
        ],
      })
      .build();
    expect(ownBound).toBe(true);
    expect(overridden.filter((id) => id === "routecraft.cache")).toHaveLength(
      1,
    );
  });

  /**
   * @case onDispose callbacks unwind in reverse registration order, after the plugin's own stop
   * @preconditions One plugin with a stop hook registers two disposers during bind()
   * @expectedResult On stop the plugin's stop runs first, then the second disposer before the first (LIFO)
   */
  test("onDispose callbacks run LIFO after stop", async () => {
    const order: string[] = [];
    const plugin: Plugin = {
      id: "test.disposer",
      bind(c) {
        c.onDispose(() => {
          order.push("first-registered");
        });
        c.onDispose(() => {
          order.push("second-registered");
        });
      },
      stop() {
        order.push("stop");
      },
    };

    t = await testContext()
      .with({ plugins: [plugin] })
      .build();

    await t.ctx.stop();

    expect(order).toEqual(["stop", "second-registered", "first-registered"]);
  });
});
