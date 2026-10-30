import { describe, test, expect, afterEach } from "bun:test";
import {
  authorityOf,
  craft,
  noop,
  ENFORCEMENT,
  type AnyRouteBuilder,
  type Plugin,
  type Principal,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import type { McpServer } from "../src/mcp/server.ts";
import { mcpPort, mcpServerFor } from "./helpers/mcp-port.ts";
import { callTool } from "./helpers/mcp-tool-call.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import { mcp } from "../src/index.ts";
import type { McpClientConfig } from "../src/mcp/port.ts";

/** A vendor client listing three tools, over a fake stdio manager. */
function seed() {
  const tools = new McpToolRegistry();
  tools.setToolsForSource("vendor", "stdio", [
    { name: "search", inputSchema: { type: "object" } },
    { name: "update", inputSchema: { type: "object" } },
    { name: "delete", inputSchema: { type: "object" } },
  ]);
  const calls: string[] = [];
  const stdio = new Map([
    [
      "vendor",
      {
        async callTool(name: string) {
          calls.push(name);
          return "ok";
        },
        async callToolRaw(name: string) {
          calls.push(name);
          return { content: [{ type: "text", text: `ok:${name}` }] };
        },
      },
    ],
  ]);
  const clients = new Map<string, McpClientConfig>([
    ["vendor", { transport: "stdio", command: "vendor-server" }],
  ]);
  return { tools, stdio, clients, calls };
}

/**
 * `tools/list` shows each caller only the tools whose route `.authorize()`
 * admits them. The listing is a view: `tools/call` still runs the route's
 * own gate, so a hidden tool is refused when called by name.
 */
describe("tools/list follows each route's .authorize()", () => {
  let t: TestContext | undefined;
  let server: McpServer | undefined;
  let calls: string[] = [];

  afterEach(async () => {
    await server?.stop().catch(() => undefined);
    server = undefined;
    if (t) await t.stop();
    t = undefined;
  });

  async function serve(
    routes: AnyRouteBuilder[],
    extra: Plugin[] = [],
  ): Promise<McpServer> {
    const s = seed();
    calls = s.calls;
    t = await testContext()
      .routes(routes)
      .with({
        plugins: [
          mcpPort({ tools: s.tools, stdio: s.stdio, clients: s.clients }),
          ...extra,
        ],
      })
      .build();
    await t.startAndWaitReady();
    server = mcpServerFor(t.ctx);
    return server;
  }

  /** An authentic principal, as a verified bearer token would produce. */
  function who(claims: Omit<Principal, "kind" | "scheme">): Principal {
    return authorityOf(t!.ctx).brand({
      kind: "custom",
      scheme: "bearer",
      ...claims,
    } as Principal);
  }

  const vendorRoutes = (): AnyRouteBuilder[] => [
    craft()
      .id("vendor")
      .authorize({ roles: ["owner"] })
      .from(mcp({ proxy: "vendor:*" }))
      .to(mcp("vendor:*")),
    craft()
      .id("vendor-search")
      .authorize({ scopes: ["vendor:read"] })
      .from(mcp({ proxy: "vendor:search" }))
      .to(mcp("vendor:search")),
  ];

  function names(
    srv: McpServer,
    principal: Principal | undefined,
    mount?: string,
  ): string[] {
    return srv
      .getAvailableTools(mount, { principal })
      .map((tool) => tool.name)
      .sort();
  }

  /**
   * @case An owner over a star route sees every tool; a member holding the exact route's scope sees only that tool
   * @preconditions Star route over vendor with authorize({ roles: ["owner"] }); exact route for vendor:search with authorize({ scopes: ["vendor:read"] })
   * @expectedResult The owner (who lacks vendor:read) is listed update and delete but not search; the member is listed search alone; on the client mount the member sees search alone too
   */
  test("owner and member are listed what their routes admit", async () => {
    const srv = await serve(vendorRoutes());
    const owner = who({ subject: "owner-1", roles: ["owner"] });
    const member = who({ subject: "member-1", scopes: ["vendor:read"] });

    expect(names(srv, owner)).toEqual(["vendor_delete", "vendor_update"]);
    expect(names(srv, member)).toEqual(["vendor_search"]);
    expect(names(srv, member, "vendor")).toEqual(["search"]);
  });

  /**
   * @case An anonymous caller is shown no tool whose route has .authorize()
   * @preconditions The same two routes plus a route with no .authorize() proxying nothing else; no principal
   * @expectedResult The listing is empty for the proxied tools
   */
  test("an anonymous caller sees no authorized tool", async () => {
    const srv = await serve(vendorRoutes());
    expect(names(srv, undefined)).toEqual([]);
  });

  /**
   * @case Stacked authorizers are AND-combined in the listing as at the gate
   * @preconditions An exact route for vendor:update with authorize({ roles: ["staff"] }) and authorize({ scopes: ["vendor:write"] })
   * @expectedResult A principal with the role and the scope is listed vendor_update; one with the role alone is not
   */
  test("stacked authorizers must all admit", async () => {
    const srv = await serve([
      craft()
        .id("vendor-update")
        .authorize({ roles: ["staff"] })
        .authorize({ scopes: ["vendor:write"] })
        .from(mcp({ proxy: "vendor:update" }))
        .to(mcp("vendor:update")),
    ]);
    const both = who({
      subject: "s-1",
      roles: ["staff"],
      scopes: ["vendor:write"],
    });
    const roleOnly = who({ subject: "s-2", roles: ["staff"] });
    expect(names(srv, both)).toEqual(["vendor_update"]);
    expect(names(srv, roleOnly)).toEqual([]);
  });

  /**
   * @case Listing and calling agree: a tool hidden from a caller is refused when called by name
   * @preconditions The member from the first case calls vendor_delete, which the star route serves to owners only
   * @expectedResult The call answers isError and the client is never reached; the member's call to vendor_search reaches it
   */
  test("a hidden tool is refused on call", async () => {
    const srv = await serve(vendorRoutes());
    const member = who({ subject: "member-1", scopes: ["vendor:read"] });
    const hidden = await callTool(srv, "vendor_delete", {}, member);
    expect(hidden.isError).toBe(true);
    expect(calls).toEqual([]);
    const listed = await callTool(srv, "vendor_search", {}, member);
    expect(listed.isError).toBeFalsy();
    expect(calls).toEqual(["search"]);
  });

  /**
   * @case A route without .authorize() lists as before, and the operator view lists everything
   * @preconditions A local route with no .authorize(), a star route restricted to owners
   * @expectedResult An anonymous caller sees the local tool; getAvailableTools() without a caller lists every tool
   */
  test("routes without authorize and the operator view are unchanged", async () => {
    const srv = await serve([
      craft()
        .id("ping")
        .description("Ping")
        .from(mcp())
        .transform(() => "pong")
        .to(noop()),
      craft()
        .id("vendor")
        .authorize({ roles: ["owner"] })
        .from(mcp({ proxy: "vendor:*" }))
        .to(mcp("vendor:*")),
    ]);
    expect(names(srv, undefined)).toEqual(["ping"]);
    expect(
      srv
        .getAvailableTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["ping", "vendor_delete", "vendor_search", "vendor_update"]);
  });

  /**
   * @case A replaced enforcement provider without admits leaves the listing unfiltered
   * @preconditions A plugin replacing ENFORCEMENT with a provider that has authorize only
   * @expectedResult An anonymous caller is listed every tool, because the server cannot guess what the replaced gate decides
   */
  test("a provider without admits lists every tool", async () => {
    const replacement: Plugin = {
      id: "test.enforcement",
      provides: [ENFORCEMENT],
      replaces: [ENFORCEMENT],
      bind(c) {
        c.provide(ENFORCEMENT, {
          authorize: () => ({ adapterId: "test.allow" }) as never,
        });
      },
    } as Plugin;
    const srv = await serve(vendorRoutes(), [replacement]);
    expect(names(srv, undefined)).toEqual([
      "vendor_delete",
      "vendor_search",
      "vendor_update",
    ]);
  });
});
