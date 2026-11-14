import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, direct, noop, simple } from "@routecraft/routecraft";
import { mcp, mcpPlugin } from "@routecraft/ai";
import { McpServer } from "../src/mcp/server.ts";
import { MCP } from "../src/mcp/port.ts";
import { StdioClientManager } from "../src/mcp/stdio-client-manager.ts";

/**
 * What one `mcpPlugin()` acquires belongs to the application that bound it,
 * and is released on every path: a stop, and a bind that threw partway.
 */
describe("mcpPlugin lifecycle", () => {
  const originalStart = StdioClientManager.prototype.start;
  const originalStop = StdioClientManager.prototype.stop;
  const originalServerStart = McpServer.prototype.start;
  let serverStarts: number;
  let stopped: StdioClientManager[];
  const contexts: TestContext[] = [];

  beforeEach(() => {
    stopped = [];
    serverStarts = 0;
    // No stdio transport on the test process: what is under test is whether
    // the plugin starts the server at all.
    McpServer.prototype.start = async function () {
      serverStarts += 1;
    };
    // No subprocess: what is under test is who releases the manager.
    StdioClientManager.prototype.start = async function () {};
    StdioClientManager.prototype.stop = async function (
      this: StdioClientManager,
    ) {
      stopped.push(this);
    };
  });

  afterEach(async () => {
    for (const t of contexts.splice(0)) await t.stop();
    StdioClientManager.prototype.start = originalStart;
    StdioClientManager.prototype.stop = originalStop;
    McpServer.prototype.start = originalServerStart;
  });

  /**
   * @case One mcpPlugin descriptor serves two applications in one process
   * @preconditions A single mcpPlugin({ clients }) with a stdio client, built into two contexts; the stdio manager's start and stop are stubbed
   * @expectedResult Each application holds its own manager, and stopping the first stops only its own while the second keeps its client
   */
  test("keeps each application's clients apart", async () => {
    const plugin = mcpPlugin({
      clients: { docs: { transport: "stdio", command: "docs-mcp" } },
    });
    const first = await testContext()
      .with({ plugins: [plugin] })
      .build();
    contexts.push(first);
    const second = await testContext()
      .with({ plugins: [plugin] })
      .build();
    contexts.push(second);

    const firstManager = first.ctx.require(MCP).stdio.get("docs");
    const secondManager = second.ctx.require(MCP).stdio.get("docs");
    expect(firstManager).toBeDefined();
    expect(secondManager).toBeDefined();
    expect(firstManager).not.toBe(secondManager);

    await first.stop();
    contexts.splice(contexts.indexOf(first), 1);
    expect(stopped).toEqual([firstManager as StdioClientManager]);
    expect(second.ctx.require(MCP).stdio.get("docs")).toBe(secondManager);

    await second.stop();
    contexts.splice(contexts.indexOf(second), 1);
    expect(stopped).toEqual([
      firstManager as StdioClientManager,
      secondManager as StdioClientManager,
    ]);
  });

  /**
   * @case A bind that throws after its clients were acquired
   * @preconditions mcpPlugin with a stdio client and an unreachable HTTP client refreshing hourly, on the http transport naming a server no plugin provides, so prepare() throws after both clients exist
   * @expectedResult The build fails, the stdio manager is stopped, and the refresh interval is cleared
   */
  test("releases what a failed bind acquired", async () => {
    const hourly = 60 * 60 * 1000;
    type IntervalId = Parameters<typeof clearInterval>[0];
    const armed = new Set<IntervalId>();
    const cleared = new Set<IntervalId>();
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((
      handler: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const id = originalSetInterval(handler, ms, ...rest) as IntervalId;
      if (ms === hourly) armed.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id?: IntervalId) => {
      cleared.add(id);
      originalClearInterval(id);
    }) as typeof clearInterval;

    let failure: unknown;
    try {
      failure = await testContext()
        .with({
          plugins: [
            mcpPlugin({
              transport: "http",
              server: "missing",
              toolRefreshInterval: "1h",
              clients: {
                docs: { transport: "stdio", command: "docs-mcp" },
                remote: { url: "http://127.0.0.1:9/mcp" },
              },
            }),
          ],
        })
        .build()
        .then(
          () => undefined,
          (err: unknown) => err,
        );
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      for (const id of armed) originalClearInterval(id);
    }

    expect(failure).toBeDefined();
    expect(stopped).toHaveLength(1);
    expect(armed.size).toBe(1);
    for (const id of armed) expect(cleared.has(id)).toBe(true);
  });

  /**
   * @case An application that only calls remote tools starts no MCP server
   * @preconditions mcpPlugin() with no transport and no route exposed as a tool; the server's start is stubbed and counted
   * @expectedResult The context starts and the server's start is never called
   */
  test("leaves the server stopped when nothing is served", async () => {
    const t = await testContext()
      .with({ plugins: [mcpPlugin()] })
      .routes([craft().id("idle").from(direct()).to(noop())])
      .build();
    contexts.push(t);
    await t.startAndWaitReady();
    expect(serverStarts).toBe(0);
  });

  /**
   * @case A route exposed as a tool starts the server without a transport being set
   * @preconditions mcpPlugin() with no transport and one .from(mcp()) route; the server's start is stubbed and counted
   * @expectedResult The server's start is called once
   */
  test("starts the server for a route exposed as a tool", async () => {
    const t = await testContext()
      .with({ plugins: [mcpPlugin()] })
      .routes([
        craft().id("echo").description("Echo the input").from(mcp()).to(noop()),
      ])
      .build();
    contexts.push(t);
    await t.startAndWaitReady();
    expect(serverStarts).toBe(1);
  });

  /**
   * @case A transport set by hand starts the server although no route is exposed yet
   * @preconditions mcpPlugin({ transport: "stdio" }) and no route exposed as a tool; the server's start is stubbed and counted
   * @expectedResult The server's start is called once
   */
  test("starts the server when a transport is set", async () => {
    const t = await testContext()
      .with({ plugins: [mcpPlugin({ transport: "stdio" })] })
      .routes([craft().id("idle").from(direct()).to(noop())])
      .build();
    contexts.push(t);
    await t.startAndWaitReady();
    expect(serverStarts).toBe(1);
  });

  /**
   * @case A route exposed as a tool after start starts the server it was skipped for
   * @preconditions mcpPlugin() with no transport and no tool route at start; two .from(mcp()) routes are registered on the running context and each switched on by an enablement re-check; the server's start is stubbed and counted
   * @expectedResult No start before the route exists, exactly one after it, and a second tool route does not start it again
   */
  test("starts the server for a tool route registered after start", async () => {
    const t = await testContext()
      .with({ plugins: [mcpPlugin()] })
      .routes([craft().id("idle").from(direct()).to(noop())])
      .build();
    contexts.push(t);
    await t.startAndWaitReady();
    expect(serverStarts).toBe(0);

    let on = false;
    for (const id of ["late", "later"]) {
      t.ctx.registerRoutes(
        ...craft()
          .id(id)
          .description("Echo the input")
          .enabled(() => on)
          .from(mcp())
          .to(noop())
          .build(),
      );
      await t.ctx.reevaluateEnablement(id);
      on = true;
      await t.ctx.reevaluateEnablement(id);
      on = false;
    }
    expect(serverStarts).toBe(1);
  });

  /**
   * @case A proxy route switched on after start starts the server too
   * @preconditions mcpPlugin() with one stdio client, no transport and no tool route at start; a .from(mcp({ proxy })) route is registered on the running context and switched on by an enablement re-check
   * @expectedResult The server's start is called once, as it is for a proxy route present at start
   */
  test("starts the server for a proxy route registered after start", async () => {
    const t = await testContext()
      .with({
        plugins: [
          mcpPlugin({
            clients: { docs: { transport: "stdio", command: "docs-mcp" } },
          }),
        ],
      })
      .routes([craft().id("idle").from(direct()).to(noop())])
      .build();
    contexts.push(t);
    await t.startAndWaitReady();
    expect(serverStarts).toBe(0);

    let on = false;
    t.ctx.registerRoutes(
      ...craft()
        .id("docs")
        .enabled(() => on)
        .from(mcp({ proxy: "docs:*" }))
        .to(mcp("docs:*"))
        .build(),
    );
    await t.ctx.reevaluateEnablement("docs");
    on = true;
    await t.ctx.reevaluateEnablement("docs");
    expect(serverStarts).toBe(1);
  });

  /**
   * @case A call to a remote tool in an application without the MCP plugin is refused
   * @preconditions No mcpPlugin; a route whose .to(mcp({ url, tool })) runs once
   * @expectedResult The exchange fails with RC5003 naming the missing plugin and how to add it
   */
  test("refuses a remote call without the plugin", async () => {
    const t = await testContext()
      .routes([
        craft()
          .id("call")
          .from(simple({}))
          .to(mcp({ url: "https://remote.example/mcp", tool: "echo" })),
      ])
      .build();
    contexts.push(t);
    await t.test();
    expect(t.errors[0]?.rc).toBe("RC5003");
    expect(t.errors[0]?.message).toMatch(/MCP plugin is not installed/);
    expect(t.errors[0]?.meta.suggestion).toMatch(/mcpPlugin\(\)/);
  });
});
