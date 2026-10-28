import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { craft, direct, log } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  agentPlugin,
  directTool,
  mcp,
  mcpPlugin,
  tools,
} from "../src/index.ts";
import { MCP, createMcpService } from "../src/mcp/port.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import { dispatchMcpCall } from "../src/mcp/dispatch.ts";

/** Collect the warning messages a context logs, keeping the bound fields. */
function captureWarnings(
  t: TestContext,
): Array<{ fields: Record<string, unknown>; message: string }> {
  const warnings: Array<{ fields: Record<string, unknown>; message: string }> =
    [];
  const original = t.ctx.logger.warn.bind(t.ctx.logger);
  t.ctx.logger.warn = ((first: unknown, second?: unknown) => {
    warnings.push(
      typeof first === "string"
        ? { fields: {}, message: first }
        : {
            fields: first as Record<string, unknown>,
            message: String(second),
          },
    );
    return original(first as never, second as never);
  }) as typeof t.ctx.logger.warn;
  return warnings;
}

/**
 * A direct route whose `.enabled()` follows a flag the test flips. A live
 * refresh cadence keeps a context whose only route is disabled running,
 * the way an application waiting on a credential stays up.
 */
function switchableRoute(id: string, flag: { on: boolean }) {
  return craft()
    .id(id)
    .enabled(() => flag.on || "LIST_TOKEN is unset", { refresh: "1h" })
    .description("List the monitors.")
    .input(z.object({}))
    .from(direct())
    .to(log());
}

describe("agent tools follow route enablement", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A Direct() ref to a registered but disabled route is left out of the offer, not thrown
   * @preconditions Route "list-monitors" disabled by its predicate with reason "LIST_TOKEN is unset"; context started
   * @expectedResult tools(["Direct(list-monitors)"]) resolves to no tools, and one warning names the ref, the route and the reason across two resolutions
   */
  test("a disabled route's Direct() ref is withheld with one warning", async () => {
    t = await testContext()
      .routes([switchableRoute("list-monitors", { on: false })])
      .with({ plugins: [agentPlugin({})] })
      .build();
    await t.startAndWaitReady();
    const warnings = captureWarnings(t);

    const selection = tools(["Direct(list-monitors)"]);
    expect(selection.resolve(t.ctx)).toEqual([]);
    expect(selection.resolve(t.ctx)).toEqual([]);

    const disabled = warnings.filter((w) => w.fields["route"] !== undefined);
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.fields).toEqual({
      tool: "Direct(list-monitors)",
      route: "list-monitors",
      reason: "LIST_TOKEN is unset",
    });
  });

  /**
   * @case The withheld tool returns once its route is enabled at runtime
   * @preconditions Route disabled at boot, then its flag flips and reevaluateEnablement() runs
   * @expectedResult Before the flip the ref resolves to nothing; after it, to one tool named direct__list-monitors
   */
  test("a refresh that enables the route brings the tool back", async () => {
    const flag = { on: false };
    t = await testContext()
      .routes([switchableRoute("list-monitors", flag)])
      .with({ plugins: [agentPlugin({})] })
      .build();
    await t.startAndWaitReady();
    captureWarnings(t);
    const selection = tools(["Direct(list-monitors)"]);
    expect(selection.resolve(t.ctx)).toEqual([]);

    flag.on = true;
    await t.ctx.reevaluateEnablement("list-monitors");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const resolved = selection.resolve(t.ctx);
    expect(resolved.map((tool) => tool.name)).toEqual([
      "direct__list-monitors",
    ]);
  });

  /**
   * @case A ref to an id no route declares still throws
   * @preconditions No route "list-monitorz"; context started
   * @expectedResult tools(["Direct(list-monitorz)"]).resolve throws RC5003, so a typo is not dropped quietly
   */
  test("an unknown Direct() id still throws RC5003", async () => {
    t = await testContext()
      .routes([switchableRoute("list-monitors", { on: false })])
      .with({ plugins: [agentPlugin({})] })
      .build();
    await t.startAndWaitReady();
    expect(() => tools(["Direct(list-monitorz)"]).resolve(t!.ctx)).toThrow(
      /unknown direct route id "list-monitorz"/,
    );
  });

  /**
   * @case A directTool fn over a disabled route does not fail the start, and is withheld at its reference
   * @preconditions agentPlugin functions { monitors: directTool("list-monitors") }; the route is disabled at boot
   * @expectedResult context starts; tools(["monitors"]) resolves to nothing with a warning naming "monitors"; once the route is enabled it resolves to the fn
   */
  test("a directTool fn over a disabled route starts and is withheld", async () => {
    const flag = { on: false };
    t = await testContext()
      .routes([switchableRoute("list-monitors", flag)])
      .with({
        plugins: [
          agentPlugin({ functions: { monitors: directTool("list-monitors") } }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    const warnings = captureWarnings(t);

    expect(tools(["monitors"]).resolve(t.ctx)).toEqual([]);
    expect(warnings.map((w) => w.fields["tool"])).toContain("monitors");

    flag.on = true;
    await t.ctx.reevaluateEnablement("list-monitors");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      tools(["monitors"])
        .resolve(t.ctx)
        .map((x) => x.name),
    ).toEqual(["monitors"]);
  });
});

describe("directTool fns over a disabled route", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case The builder form of tools(), which a markdown agent uses, does not trip over a withheld fn
   * @preconditions agentPlugin functions { monitors: directTool("list-monitors") } with that route disabled; a second route "send-mail" enabled; a builder selection naming only Direct(send-mail)
   * @expectedResult The builder resolves to direct__send-mail, and its catalog does not list "monitors"
   */
  test("a builder selection resolves while a fn's route is disabled", async () => {
    t = await testContext()
      .routes([
        switchableRoute("list-monitors", { on: false }),
        switchableRoute("send-mail", { on: true }),
      ])
      .with({
        plugins: [
          agentPlugin({ functions: { monitors: directTool("list-monitors") } }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    let listed: string[] = [];
    const selection = tools((catalog) => {
      listed = catalog.fns.map((fn) => fn.name);
      return ["Direct(send-mail)"];
    });
    expect(selection.resolve(t.ctx).map((tool) => tool.name)).toEqual([
      "direct__send-mail",
    ]);
    expect(listed).not.toContain("monitors");
  });

  /**
   * @case A fn over a disabled route still fails the start when its route has no description
   * @preconditions directTool("bare") over a disabled route that declares .input() but no .description()
   * @expectedResult context start rejects with RC5003 naming the missing description, as it would for an enabled route
   */
  test("a fn over a disabled route is still checked at start", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("bare")
          .enabled(() => "BARE_TOKEN is unset", { refresh: "1h" })
          .input(z.object({}))
          .from(direct())
          .to(log()),
      ])
      .with({
        plugins: [agentPlugin({ functions: { bare: directTool("bare") } })],
      })
      .build();
    await expect(t.ctx.start()).rejects.toThrow(/has no \.description\(\)/);
  });

  /**
   * @case A synchronous fn over a disabled route that can park still fails the start
   * @preconditions directTool("park", { background: false }) over a disabled, described route with a .defer()
   * @expectedResult context start rejects with RC5003 naming the route as able to park, as it would for an enabled route
   */
  test("background: false over a disabled parking route is refused at start", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("park")
          .enabled(() => "PARK_TOKEN is unset", { refresh: "1h" })
          .description("Ask before acting")
          .input(z.object({}))
          .from(direct())
          .defer({ schema: z.object({ ok: z.boolean() }) })
          .to(log()),
      ])
      .with({
        deferral: {},
        plugins: [
          agentPlugin({
            functions: { park: directTool("park", { background: false }) },
          }),
        ],
      })
      .build();
    await expect(t.ctx.start()).rejects.toThrow(/route "park" can park/);
  });

  /**
   * @case A fn whose route comes up after start resolves once and is announced then
   * @preconditions directTool fn "monitors" over a route disabled at start; the route is enabled; the fn is referenced on two dispatches
   * @expectedResult One agent:tool:registered event for "monitors" after the route came up, and none at start
   */
  test("a late-resolved fn is announced once", async () => {
    const flag = { on: false };
    t = await testContext()
      .routes([switchableRoute("list-monitors", flag)])
      .with({
        plugins: [
          agentPlugin({ functions: { monitors: directTool("list-monitors") } }),
        ],
      })
      .build();
    const announced: string[] = [];
    t.ctx.on("agent:tool:registered", ({ details }) => {
      announced.push(details.toolName);
    });
    await t.startAndWaitReady();
    expect(announced).toEqual([]);

    flag.on = true;
    await t.ctx.reevaluateEnablement("list-monitors");
    await new Promise((resolve) => setTimeout(resolve, 20));
    tools(["monitors"]).resolve(t.ctx);
    tools(["monitors"]).resolve(t.ctx);
    expect(announced).toEqual(["monitors"]);
  });
});

/** An MCP service whose clients are declared the way the plugin declares them. */
async function contextWithClients(seed: {
  clients?: string[];
  disabled?: Record<string, string>;
  tools?: Record<string, string[]>;
}): Promise<TestContext> {
  return await testContext()
    .with({
      plugins: [
        agentPlugin({}),
        {
          id: "test.mcp-clients",
          provides: [MCP],
          bind(c) {
            const registry = new McpToolRegistry();
            for (const [source, names] of Object.entries(seed.tools ?? {})) {
              registry.setToolsForSource(
                source,
                "http",
                names.map((name) => ({
                  name,
                  inputSchema: { type: "object" as const },
                })),
              );
            }
            c.provide(
              MCP,
              createMcpService({
                tools: registry,
                clients: new Map(
                  (seed.clients ?? []).map((id) => [
                    id,
                    { url: `http://127.0.0.1:9/${id}` },
                  ]),
                ),
                disabledClients: new Map(Object.entries(seed.disabled ?? {})),
              }),
            );
          },
        },
      ],
    })
    .build();
}

describe("agent MCP refs follow client configuration", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case An MCP ref to a declared but disabled client is withheld with one warning naming the reason
   * @preconditions Client "vendor" disabled with reason "VENDOR_TOKEN is unset"
   * @expectedResult MCP(vendor:search) and MCP(vendor) resolve to nothing; one warning per ref carries the client and the reason, also on a second resolution
   */
  test("a disabled client's refs are withheld with the reason", async () => {
    t = await contextWithClients({
      disabled: { vendor: "VENDOR_TOKEN is unset" },
    });
    const warnings = captureWarnings(t);
    const selection = tools(["MCP(vendor:search)", "MCP(vendor)"]);
    expect(selection.resolve(t.ctx)).toEqual([]);
    expect(selection.resolve(t.ctx)).toEqual([]);
    expect(warnings.map((w) => w.fields)).toEqual([
      {
        tool: "MCP(vendor:search)",
        client: "vendor",
        reason: "VENDOR_TOKEN is unset",
      },
      {
        tool: "MCP(vendor)",
        client: "vendor",
        reason: "VENDOR_TOKEN is unset",
      },
    ]);
  });

  /**
   * @case A ref to a declared, enabled client with no registered tools is withheld
   * @preconditions Client "vendor" configured; the registry holds no tools for it (still connecting, or its listing failed)
   * @expectedResult MCP(vendor:search) resolves to nothing with a warning, and resolves once the client lists the tool
   */
  test("a configured client with no tools yet is withheld until it lists them", async () => {
    t = await contextWithClients({ clients: ["vendor"] });
    const warnings = captureWarnings(t);
    expect(tools(["MCP(vendor:search)"]).resolve(t.ctx)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields["client"]).toBe("vendor");

    t.ctx
      .lookup(MCP)!
      .tools.setToolsForSource("vendor", "http", [
        { name: "search", inputSchema: { type: "object" } },
      ]);
    expect(
      tools(["MCP(vendor:search)"])
        .resolve(t.ctx)
        .map((tool) => tool.name),
    ).toEqual(["mcp__vendor__search"]);
  });

  /**
   * @case A ref to a tool a live client does not list is withheld, not thrown
   * @preconditions Client "vendor" lists "search" and "lookup"; the ref names "find" (renamed by the remote, or misspelled)
   * @expectedResult Resolves to nothing; the warning lists the tools the client does list
   */
  test("a tool the client does not list is withheld with the known tools", async () => {
    t = await contextWithClients({
      clients: ["vendor"],
      tools: { vendor: ["search", "lookup"] },
    });
    const warnings = captureWarnings(t);
    expect(tools(["MCP(vendor:find)"]).resolve(t.ctx)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields["known"]).toEqual(["lookup", "search"]);
  });

  /**
   * @case A ref to a client id matching no configuration still throws
   * @preconditions Clients "vendor" (configured) and "ledger" (disabled); the ref names "vendr"
   * @expectedResult RC5003 naming "vendr" and listing both declared clients
   */
  test("an unknown client id still throws RC5003", async () => {
    t = await contextWithClients({
      clients: ["vendor"],
      disabled: { ledger: "LEDGER_TOKEN is unset" },
      tools: { vendor: ["search"] },
    });
    expect(() => tools(["MCP(vendr:search)"]).resolve(t!.ctx)).toThrow(
      /client "vendr" is not configured.*"ledger", "vendor"/s,
    );
  });
});

describe("mcpPlugin({ clients: { enabled } })", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A disabled client is declared but never connected, and a proxy route over it starts
   * @preconditions Client "vendor" at an unreachable URL with enabled: "VENDOR_TOKEN is unset"; a star proxy route over it
   * @expectedResult The context starts; the service lists vendor as disabled with the reason and not among the clients; a call to it is refused naming the reason
   */
  test("a disabled client opens no connection and refuses calls with the reason", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("vendor")
          .from(mcp({ proxy: "vendor:*" }))
          .to(mcp("vendor:*")),
      ])
      .with({
        plugins: [
          agentPlugin({}),
          mcpPlugin({
            clients: {
              vendor: {
                url: "http://127.0.0.1:9/mcp",
                enabled: "VENDOR_TOKEN is unset",
              },
            },
            toolRefreshInterval: 0,
          }),
        ],
      })
      .build();
    await t.startAndWaitReady();

    const service = t.ctx.lookup(MCP)!;
    expect(service.clients.has("vendor")).toBe(false);
    expect(service.disabledClients.get("vendor")).toBe("VENDOR_TOKEN is unset");
    expect(service.tools.getToolsByServer("vendor")).toEqual([]);
    await expect(
      dispatchMcpCall(service, "vendor", "search", {}),
    ).rejects.toThrow(/client "vendor" is disabled \(VENDOR_TOKEN is unset\)/);
  });

  /**
   * @case A predicate that answers true leaves the client configured
   * @preconditions Client "vendor" with enabled: () => true
   * @expectedResult The client is among the configured clients and not among the disabled
   */
  test("an enabled predicate leaves the client configured", async () => {
    t = await testContext()
      .with({
        plugins: [
          mcpPlugin({
            clients: {
              vendor: { url: "http://127.0.0.1:9/mcp", enabled: () => true },
            },
            toolRefreshInterval: 0,
          }),
        ],
      })
      .build();
    const service = t.ctx.lookup(MCP)!;
    expect(service.clients.has("vendor")).toBe(true);
    expect(service.disabledClients.has("vendor")).toBe(false);
  });

  /**
   * @case A malformed enabled value is refused when the plugin is configured
   * @preconditions enabled: 42
   * @expectedResult mcpPlugin() throws naming the client and the accepted shapes
   */
  test("a malformed enabled value is refused", () => {
    expect(() =>
      mcpPlugin({
        clients: {
          vendor: { url: "http://127.0.0.1:9/mcp", enabled: 42 as never },
        },
      }),
    ).toThrow(/clients\.vendor\.enabled must be/);
  });
});
