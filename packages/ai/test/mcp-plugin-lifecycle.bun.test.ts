import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import { mcpPlugin } from "@routecraft/ai";
import { MCP } from "../src/mcp/port.ts";
import { StdioClientManager } from "../src/mcp/stdio-client-manager.ts";

/**
 * What one `mcpPlugin()` acquires belongs to the application that bound it,
 * and is released on every path: a stop, and a bind that threw partway.
 */
describe("mcpPlugin lifecycle", () => {
  const originalStart = StdioClientManager.prototype.start;
  const originalStop = StdioClientManager.prototype.stop;
  let stopped: StdioClientManager[];
  const contexts: TestContext[] = [];

  beforeEach(() => {
    stopped = [];
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
});
