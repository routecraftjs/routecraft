import { afterEach, describe, expect, test } from "bun:test";
import { craft, opsPlugin, type AnyRouteBuilder } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import type { McpServer } from "../src/mcp/server.ts";
import { mcpPort, mcpServerFor } from "./helpers/mcp-port.ts";
import { callTool } from "./helpers/mcp-tool-call.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import { mcp } from "../src/index.ts";
import type { McpClientConfig } from "../src/mcp/port.ts";

type Standby = { routeId: string; standby: boolean; reason?: string };

/**
 * An exact proxy route whose remote tool its client no longer lists says
 * so: one warning, and the route on standby until a listing carries the
 * tool again. Calls stay fail-closed throughout.
 */
describe("exact proxy routes over a missing remote tool", () => {
  let t: TestContext | undefined;
  let server: McpServer | undefined;

  afterEach(async () => {
    await server?.stop().catch(() => undefined);
    server = undefined;
    if (t) await t.stop();
    t = undefined;
  });

  async function serve(
    routes: AnyRouteBuilder[],
    tools: string[],
  ): Promise<{
    registry: McpToolRegistry;
    events: Standby[];
    warnings: Array<Record<string, unknown>>;
  }> {
    const registry = new McpToolRegistry();
    registry.setToolsForSource(
      "vendor",
      "stdio",
      tools.map((name) => ({ name, inputSchema: { type: "object" } })),
    );
    const clients = new Map<string, McpClientConfig>([
      ["vendor", { transport: "stdio", command: "vendor-server" }],
    ]);
    const stdio = new Map([
      [
        "vendor",
        {
          callTool: async () => "ok",
          callToolRaw: async (name: string) => ({
            content: [{ type: "text", text: `ok:${name}` }],
          }),
        },
      ],
    ]);
    t = await testContext()
      .with({
        plugins: [
          mcpPort({ tools: registry, clients, stdio }),
          opsPlugin({ health: { details: "always" } }),
        ],
      })
      .with({ servers: { default: { host: "127.0.0.1", port: 0 } } })
      .routes(routes)
      .build();
    const events: Standby[] = [];
    t.ctx.on("route:standby:changed", ({ details }) => {
      events.push({ ...details });
    });
    const warnings: Array<Record<string, unknown>> = [];
    const original = t.ctx.logger.warn.bind(t.ctx.logger);
    t.ctx.logger.warn = ((first: unknown, second?: unknown) => {
      if (typeof first === "object" && first !== null) {
        warnings.push(first as Record<string, unknown>);
      }
      return original(first as never, second as never);
    }) as typeof t.ctx.logger.warn;
    server = mcpServerFor(t.ctx, { transport: "http" });
    await server.prepare();
    await t.startAndWaitReady();
    await server.start();
    return { registry, events, warnings };
  }

  const exactSearch = (): AnyRouteBuilder =>
    craft()
      .id("vendor-search")
      .from(mcp({ proxy: "vendor:search" }))
      .to(mcp("vendor:search"));

  /**
   * @case A renamed remote tool puts its exact route on standby at start, with one warning
   * @preconditions The client lists "find" and "update"; an exact route proxies "vendor:search"
   * @expectedResult One route:standby:changed { standby: true } naming the client and the tool, one warning naming the known tools, and a call to vendor_search fails closed
   */
  test("a missing tool at start warns and puts the route on standby", async () => {
    const { events, warnings } = await serve(
      [exactSearch()],
      ["find", "update"],
    );
    expect(events).toEqual([
      {
        routeId: "vendor-search",
        standby: true,
        reason: 'client "vendor" does not list tool "search"',
      },
    ]);
    const missing = warnings.filter((w) => w["route"] === "vendor-search");
    expect(missing).toEqual([
      {
        route: "vendor-search",
        client: "vendor",
        tool: "search",
        known: ["find", "update"],
      },
    ]);
    const result = await callTool(server!, "vendor_search", {});
    expect(result.isError).toBe(true);
  });

  /**
   * @case The route comes off standby when a refresh lists the tool again, and goes back on when it disappears
   * @preconditions Start without "search"; the registry re-lists with "search"; then re-lists without it
   * @expectedResult Events standby true, false, true in that order; a re-listing that changes nothing emits nothing
   */
  test("refreshes move the route on and off standby", async () => {
    const { registry, events } = await serve([exactSearch()], ["find"]);
    const list = (names: string[]) =>
      registry.setToolsForSource(
        "vendor",
        "stdio",
        names.map((name) => ({ name, inputSchema: { type: "object" } })),
      );
    list(["find", "search"]);
    list(["find", "search"]);
    list(["find"]);
    expect(events.map((e) => e.standby)).toEqual([true, false, true]);
  });

  /**
   * @case A server started again announces the recovery of a route it had put on standby
   * @preconditions An exact route on standby; the MCP server stops while the route stays registered, the client lists the tool, and the server starts again
   * @expectedResult route:standby:changed { standby: false } follows the standby event, so the route is not left stuck on standby
   */
  test("a restarted server announces a recovery", async () => {
    const { registry, events } = await serve([exactSearch()], ["find"]);
    await server!.stop();
    registry.setToolsForSource("vendor", "stdio", [
      { name: "search", inputSchema: { type: "object" } },
    ]);
    await server!.start();
    expect(events).toEqual([
      {
        routeId: "vendor-search",
        standby: true,
        reason: 'client "vendor" does not list tool "search"',
      },
      { routeId: "vendor-search", standby: false },
    ]);
  });

  /**
   * @case An exact route whose tool is listed, and a star route, emit nothing
   * @preconditions The client lists "search"; an exact route over vendor:search and a star route over vendor
   * @expectedResult No route:standby:changed event and no warning naming either route
   */
  test("a listed tool and a star route stay quiet", async () => {
    const { events, warnings } = await serve(
      [
        exactSearch(),
        craft()
          .id("vendor")
          .from(mcp({ proxy: "vendor:*" }))
          .to(mcp("vendor:*")),
      ],
      ["search"],
    );
    expect(events).toEqual([]);
    expect(warnings.filter((w) => w["route"] !== undefined)).toEqual([]);
  });

  /**
   * @case Stopping a route on standby reports no recovery on the way out
   * @preconditions An exact route on standby (its tool unlisted), with the ops plugin recording health transitions; the context stops
   * @expectedResult No plugin:ops:health:changed for the route moves it to up: the withdrawal on stop is not the tool coming back
   */
  test("a standby route stops without a false recovery", async () => {
    await serve([exactSearch()], ["find"]);
    const moves: Array<{ to: string }> = [];
    t!.ctx.on("plugin:ops:health:changed", ({ details }) => {
      if (details.name === "vendor-search") moves.push({ to: details.to });
    });
    await server!.stop();
    server = undefined;
    await t!.stop();
    t = undefined;
    expect(moves.filter((m) => m.to === "up")).toEqual([]);
  });

  /**
   * @case A client that has listed no tools puts its exact route on standby with that reason
   * @preconditions The registry holds no tools for vendor (its listing failed or has not run)
   * @expectedResult One standby event whose reason says the client has listed no tools
   */
  test("a client with no tools gives its own reason", async () => {
    const { events } = await serve([exactSearch()], []);
    expect(events).toEqual([
      {
        routeId: "vendor-search",
        standby: true,
        reason: 'client "vendor" has listed no tools',
      },
    ]);
  });
});
