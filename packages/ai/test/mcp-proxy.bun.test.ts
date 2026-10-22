import { describe, test, expect, afterEach } from "bun:test";
import {
  authorityOf,
  craft,
  noop,
  type AnyRouteBuilder,
  type Exchange,
} from "@routecraft/routecraft";
import { deferring, testContext, type TestContext } from "@routecraft/testing";
import type { McpServer } from "../src/mcp/server.ts";
import { mcpPort, mcpServerFor } from "./helpers/mcp-port.ts";
import { callTool } from "./helpers/mcp-tool-call.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import { mcp, McpHeadersKeys, sessionsPlugin, tools } from "../src/index.ts";
import { makeFnHandlerContext } from "../src/fn/handler-context.ts";
import { MemorySessionStore } from "../src/agent/session/memory-store.ts";
import type { McpClientConfig } from "../src/mcp/port.ts";
import type { McpRawToolResult } from "../src/mcp/types.ts";

/** Recorded dispatches from the fake stdio managers. */
let dispatches: Array<{
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
}> = [];

/** The remote tools the "docs" and "billing" clients list. */
function buildRegistry(): McpToolRegistry {
  const registry = new McpToolRegistry();
  registry.setToolsForSource("docs", "stdio", [
    {
      name: "get_document",
      title: "Get document",
      description: "Read one document by id",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      outputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      annotations: { readOnlyHint: true },
      icons: [{ src: "https://docs.example/icon.svg" }],
    },
    {
      name: "search",
      description: "Search documents",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: "delete_document",
      description: "Delete one document",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      annotations: { destructiveHint: true },
    },
  ]);
  registry.setToolsForSource("billing", "stdio", [
    {
      name: "search",
      description: "Search invoices",
      inputSchema: { type: "object" },
    },
  ]);
  return registry;
}

/** The clients the registry's tools belong to, as the plugin registers them. */
function buildClients(): Map<string, McpClientConfig> {
  return new Map<string, McpClientConfig>([
    ["docs", { transport: "stdio", command: "docs-server" }],
    ["billing", { transport: "stdio", command: "billing-server" }],
  ]);
}

/** The slice of a stdio client manager the service dispatches through. */
type FakeManager = {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  callToolRaw(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpRawToolResult>;
};

/** Fake stdio managers recording calls and answering with a raw MCP result. */
function buildManagers(
  answer?: (toolName: string) => McpRawToolResult,
): Map<string, FakeManager> {
  const managers = new Map<string, FakeManager>();
  for (const serverId of ["docs", "billing"]) {
    managers.set(serverId, {
      async callTool(name, args) {
        dispatches.push({ serverId, toolName: name, args });
        return "extracted";
      },
      async callToolRaw(name, args) {
        dispatches.push({ serverId, toolName: name, args });
        return (
          answer?.(name) ?? {
            content: [{ type: "text", text: `raw:${serverId}:${name}` }],
          }
        );
      },
    });
  }
  return managers;
}

describe("a route that proxies a remote MCP server", () => {
  let t: TestContext;
  let server: McpServer;

  afterEach(async () => {
    dispatches = [];
    if (server) {
      try {
        await server.stop();
      } catch {
        // ignore
      }
    }
    if (t) {
      await t.stop();
    }
  });

  /**
   * Build a context holding `routes` over the fake docs and billing clients,
   * start it, and return an McpServer reading from it.
   */
  async function serve(
    routes: AnyRouteBuilder[],
    options: {
      registry?: McpToolRegistry;
      answer?: (toolName: string) => McpRawToolResult;
      server?: ConstructorParameters<typeof McpServer>[1];
    } = {},
  ): Promise<McpServer> {
    t = await testContext()
      .routes(routes)
      .with({
        plugins: [
          mcpPort({
            tools: options.registry ?? buildRegistry(),
            stdio: buildManagers(options.answer),
            clients: buildClients(),
          }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    server = mcpServerFor(t.ctx, options.server);
    return server;
  }

  function call(name: string, args: Record<string, unknown>) {
    return callTool(server, name, args);
  }

  /**
   * @case A star route exposes every tool of the client, prefixed, with the remote's metadata passed through
   * @preconditions craft().from(mcp({ proxy: "docs:*" })).to(mcp("docs:*")); the docs client lists three tools
   * @expectedResult tools/list carries docs_get_document, docs_search and docs_delete_document with the remote inputSchema, outputSchema, title, description, annotations and icons; the route id is not a tool
   */
  test("a star route exposes the client's tools under the prefix with metadata through", async () => {
    await serve([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .to(mcp("docs:*")),
    ]);

    const listed = server.getAvailableTools();
    expect(listed.map((tool) => tool.name).sort()).toEqual([
      "docs_delete_document",
      "docs_get_document",
      "docs_search",
    ]);
    const get = listed.find((tool) => tool.name === "docs_get_document")!;
    expect(get.title).toBe("Get document");
    expect(get.description).toBe("Read one document by id");
    expect(get.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    expect(get.outputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
    });
    expect(get.annotations).toEqual({ readOnlyHint: true });
    expect(get.icons).toEqual([{ src: "https://docs.example/icon.svg" }]);
  });

  /**
   * @case A call runs the route: steps before the hop see the arguments, the hop forwards the named tool, steps after see the result
   * @preconditions Star route with a transform before .to(mcp("docs:*")) and a transform after it
   * @expectedResult The remote receives the rewritten arguments under the remote tool name; the caller receives the rewritten result as structured content, because the remote advertises an output schema
   */
  test("a call runs the route around the hop", async () => {
    const seen: Array<{ tool: unknown; client: unknown }> = [];
    await serve(
      [
        craft()
          .id("docs")
          .from(mcp({ proxy: "docs:*" }))
          .transform((args, ex: Exchange) => {
            seen.push({
              tool: ex.headers[McpHeadersKeys.TOOL],
              client: ex.headers[McpHeadersKeys.CLIENT],
            });
            const given = args as Record<string, unknown>;
            return { ...given, id: `doc-${String(given["id"])}` };
          })
          .to(mcp("docs:*"))
          .transform((result) => ({ text: (result as { text: string }).text })),
      ],
      {
        answer: () => ({
          content: [{ type: "text", text: "ignored when structured" }],
          structuredContent: { text: "hello", author_email: "a@b.c" },
        }),
      },
    );

    const result = await call("docs_get_document", { id: "42" });

    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "get_document", args: { id: "doc-42" } },
    ]);
    expect(seen).toEqual([{ tool: "get_document", client: "docs" }]);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ text: "hello" });
  });

  /**
   * @case An exact route exposes one tool and wins over the star route for it
   * @preconditions A star route over docs and an exact route over docs:get_document with its own description and a name override
   * @expectedResult tools/list carries "fetch_doc" with the route's description beside the star's other two tools; a call to fetch_doc runs the exact route
   */
  test("an exact route wins over the star route for the tool it names", async () => {
    const ran: string[] = [];
    await serve([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .process((ex) => {
          ran.push("star");
          return ex;
        })
        .to(mcp("docs:*")),
      craft()
        .id("fetch")
        .description("Fetch a document, our way")
        .from(mcp({ proxy: "docs:get_document", name: "fetch_doc" }))
        .process((ex) => {
          ran.push("exact");
          return ex;
        })
        .to(mcp("docs:get_document")),
    ]);

    const listed = server.getAvailableTools();
    expect(listed.map((tool) => tool.name).sort()).toEqual([
      "docs_delete_document",
      "docs_search",
      "fetch_doc",
    ]);
    expect(listed.find((tool) => tool.name === "fetch_doc")?.description).toBe(
      "Fetch a document, our way",
    );

    const fetched = await call("fetch_doc", { id: "1" });
    expect(fetched.content[0]?.text).not.toContain("Error");
    expect(ran).toEqual(["exact"]);
    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "get_document", args: { id: "1" } },
    ]);
  });

  /**
   * @case A star route's exclude leaves tools out of the group on every mount, and an exact route over one of them stands alone
   * @preconditions Star route over docs excluding search and get_document, an exact route over get_document
   * @expectedResult The root lists docs_delete_document and docs_get_document only, the docs mount delete_document and get_document; a call to docs_search is not found; get_document runs the exact route
   */
  test("a star route can exclude tools", async () => {
    const ran: string[] = [];
    await serve([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*", exclude: ["search", "get_document"] }))
        .process((ex) => {
          ran.push("star");
          return ex;
        })
        .to(mcp("docs:*")),
      craft()
        .id("fetch")
        .from(mcp({ proxy: "docs:get_document" }))
        .process((ex) => {
          ran.push("exact");
          return ex;
        })
        .to(mcp("docs:get_document")),
    ]);
    expect(
      server
        .getAvailableTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["docs_delete_document", "docs_get_document"]);
    expect(
      server
        .getAvailableTools("docs")
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["delete_document", "get_document"]);
    const missing = await call("docs_search", {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("Tool not found");
    await call("docs_get_document", { id: "1" });
    expect(ran).toEqual(["exact"]);
  });

  /**
   * @case A bare prefix exposes the remote names as they are
   * @preconditions Star route over docs with prefix ""
   * @expectedResult tools/list carries get_document, search and delete_document
   */
  test('prefix: "" exposes the remote names bare', async () => {
    await serve([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*", prefix: "" }))
        .to(mcp("docs:*")),
    ]);
    expect(
      server
        .getAvailableTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["delete_document", "get_document", "search"]);
  });

  /**
   * @case Two clients with a tool of the same name never collide under the default prefix
   * @preconditions Star routes over docs and billing, both of which list "search"
   * @expectedResult docs_search and billing_search are both exposed and each forwards to its own client
   */
  test("the default prefix keeps two clients' equal tool names apart", async () => {
    await serve([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .to(mcp("docs:*")),
      craft()
        .id("billing")
        .from(mcp({ proxy: "billing:*" }))
        .to(mcp("billing:*")),
    ]);
    const names = server.getAvailableTools().map((tool) => tool.name);
    expect(names).toContain("docs_search");
    expect(names).toContain("billing_search");

    await call("billing_search", { q: "inv" });
    expect(dispatches).toEqual([
      { serverId: "billing", toolName: "search", args: { q: "inv" } },
    ]);
  });

  /**
   * @case Bare prefixes that collide keep the first route's tool and warn
   * @preconditions Star routes over docs and billing, both with prefix ""; both list "search"
   * @expectedResult One "search" is exposed, forwarding to docs; a warning names both routes
   */
  test("a collision between bare names keeps the first and warns", async () => {
    await serve([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*", prefix: "" }))
        .to(mcp("docs:*")),
      craft()
        .id("billing")
        .from(mcp({ proxy: "billing:*", prefix: "" }))
        .to(mcp("billing:*")),
    ]);
    const names = server.getAvailableTools().map((tool) => tool.name);
    expect(names.filter((name) => name === "search")).toHaveLength(1);
    await call("search", {});
    expect(dispatches.map((d) => d.serverId)).toEqual(["docs"]);
    const warned = t.contextLogger.warn.mock.calls.find(
      (c: unknown[]) =>
        typeof c[1] === "string" && c[1].includes("the first keeps it"),
    );
    expect(warned?.[0]).toMatchObject({
      exposed: "search",
      route: "docs",
      otherRoute: "billing",
    });
  });

  /**
   * @case A local mcp() route keeps a name a proxied tool would take
   * @preconditions A local route named docs_search and a star route over docs
   * @expectedResult tools/list carries one docs_search, the local one; a call runs the local route and reaches no client; a warning names the proxy route
   */
  test("a local route wins a name over a proxied tool", async () => {
    await serve([
      craft()
        .id("docs_search")
        .description("Our own search")
        .from(mcp())
        .transform(() => ({ local: true }))
        .to(noop()),
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .to(mcp("docs:*")),
    ]);
    const listed = server.getAvailableTools();
    expect(listed.filter((tool) => tool.name === "docs_search")).toHaveLength(
      1,
    );
    expect(
      listed.find((tool) => tool.name === "docs_search")?.description,
    ).toBe("Our own search");
    const result = await call("docs_search", {});
    expect(dispatches).toEqual([]);
    expect(result.content[0]?.text).toContain("local");
    const warned = t.contextLogger.warn.mock.calls.find(
      (c: unknown[]) =>
        typeof c[1] === "string" && c[1].includes("the route keeps it"),
    );
    expect(warned?.[0]).toMatchObject({
      route: "docs",
      exposed: "docs_search",
    });
  });

  /**
   * @case A local route the tools filter excludes does not hold its name over a proxied tool
   * @preconditions A local route docs_search and a star route over docs, with a server tools filter that excludes the local route's entry
   * @expectedResult tools/list carries one docs_search, the proxied one, and a call reaches the docs client
   */
  test("a filtered-out local route yields its name to the proxied tool", async () => {
    await serve(
      [
        craft()
          .id("docs_search")
          .description("Our own search")
          .from(mcp())
          .transform(() => ({ local: true }))
          .to(noop()),
        craft()
          .id("docs")
          .from(mcp({ proxy: "docs:*" }))
          .to(mcp("docs:*")),
      ],
      { server: { tools: (entry) => entry.description !== "Our own search" } },
    );
    const listed = server.getAvailableTools();
    expect(listed.filter((tool) => tool.name === "docs_search")).toHaveLength(
      1,
    );
    expect(
      listed.find((tool) => tool.name === "docs_search")?.description,
    ).not.toBe("Our own search");
    await call("docs_search", { q: "x" });
    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "search", args: { q: "x" } },
    ]);
  });

  /**
   * @case A stdio client is told when the advertised tool set changes
   * @preconditions Star route over docs with a stdio instance observing; the registry re-lists docs with a tool added, then re-lists it unchanged; then a local route registers
   * @expectedResult tools/list_changed is sent once for the added tool, not for the unchanged listing, and once more for the local route
   */
  test("a changed tool set notifies the stdio client once per change", async () => {
    const registry = buildRegistry();
    await serve(
      [
        craft()
          .id("docs")
          .from(mcp({ proxy: "docs:*" }))
          .to(mcp("docs:*")),
      ],
      { registry },
    );
    let sent = 0;
    const observing = server as unknown as {
      stdioServers: Set<{ sendToolListChanged(): void }>;
      observeClientListings(): void;
    };
    observing.stdioServers.add({
      sendToolListChanged() {
        sent++;
      },
    });
    observing.observeClientListings();
    const listed = () =>
      t.ctx.emit(
        "plugin:mcp:client:docs:tools:listed" as never,
        {
          serverId: "docs",
        } as never,
      );

    registry.setToolsForSource("docs", "stdio", [
      {
        name: "get_document",
        description: "Read one document by id",
        inputSchema: { type: "object" },
      },
      {
        name: "search",
        description: "Search documents",
        inputSchema: { type: "object" },
      },
      {
        name: "delete_document",
        description: "Delete a document",
        inputSchema: { type: "object" },
      },
      {
        name: "list_documents",
        description: "List documents",
        inputSchema: { type: "object" },
      },
    ]);
    listed();
    expect(sent).toBe(1);
    listed();
    expect(sent).toBe(1);

    const service = t.ctx.lookup((await import("../src/mcp/port.ts")).MCP)!;
    const withdraw = service.registerLocal({
      endpoint: "late",
      description: "A route that registered after the client connected",
      handler: async () => {
        throw new Error("never called");
      },
    });
    expect(sent).toBe(2);
    withdraw();
    expect(sent).toBe(3);
  });

  /**
   * @case A remote error on a hop that is not the proxied tool stays generic
   * @preconditions A local mcp() route "own" whose hop calls docs:get_document; the docs client answers with isError and "File not found"
   * @expectedResult The caller gets the generic failure text with AI2003 and none of the remote's text
   */
  test("a remote error off the proxied hop does not cross the wire", async () => {
    await serve(
      [
        craft()
          .id("own")
          .description("Reads a document through our own route")
          .from(mcp())
          .to(mcp("docs:get_document")),
      ],
      {
        answer: () => ({
          content: [{ type: "text", text: "File not found" }],
          isError: true,
        }),
      },
    );
    const result = await call("own", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Error: Tool "own" failed (AI2003).');
  });

  /**
   * @case The star hop refuses a local mcp() route's own exchange
   * @preconditions A local mcp() route "own" ending in .to(mcp("docs:*")); the server sets the tool header to "own" but no client header
   * @expectedResult The call fails with RC5003 and the docs client is never reached
   */
  test("the star enricher refuses a local route's exchange", async () => {
    await serve([
      craft()
        .id("own")
        .description("Forwards nothing")
        .from(mcp())
        .to(mcp("docs:*")),
    ]);
    const result = await call("own", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("RC5003");
    expect(dispatches).toEqual([]);
  });

  /**
   * @case The star hop refuses another client's proxied exchange
   * @preconditions A star route over docs whose hop is .to(mcp("billing:*"))
   * @expectedResult The call fails with RC5003 and neither client is reached
   */
  test("the star enricher refuses a hop to a different client", async () => {
    await serve([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .to(mcp("billing:*")),
    ]);
    const result = await call("docs_get_document", { id: "1" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("RC5003");
    expect(dispatches).toEqual([]);
  });

  /**
   * @case The exposed set follows the client's live tool list
   * @preconditions Star route over docs; the registry re-lists docs with one tool added and one removed
   * @expectedResult The new tool is listed and callable, the removed one is gone and answers tool-not-found
   */
  test("a star route follows the client's tool list", async () => {
    const registry = buildRegistry();
    await serve(
      [
        craft()
          .id("docs")
          .from(mcp({ proxy: "docs:*" }))
          .to(mcp("docs:*")),
      ],
      { registry },
    );
    expect(server.getAvailableTools().map((tool) => tool.name)).toContain(
      "docs_search",
    );

    registry.setToolsForSource("docs", "stdio", [
      {
        name: "get_document",
        description: "Read one document by id",
        inputSchema: { type: "object" },
      },
      {
        name: "list_documents",
        description: "List documents",
        inputSchema: { type: "object" },
      },
    ]);

    const names = server.getAvailableTools().map((tool) => tool.name);
    expect(names).toContain("docs_list_documents");
    expect(names).not.toContain("docs_search");
    await call("docs_list_documents", {});
    expect(dispatches.at(-1)).toEqual({
      serverId: "docs",
      toolName: "list_documents",
      args: {},
    });
    const gone = await call("docs_search", {});
    expect(gone.isError).toBe(true);
    expect(gone.content[0]?.text).toContain("Tool not found");
  });

  /**
   * @case A remote error result fails the call and carries the remote's text to the caller
   * @preconditions Star route over docs; the docs client answers get_document with isError and "File not found"
   * @expectedResult The caller receives isError with the remote text; plugin:mcp:tool:failed carries proxied provenance
   */
  test("a remote error result reaches the caller as a failure with the remote's text", async () => {
    await serve(
      [
        craft()
          .id("docs")
          .from(mcp({ proxy: "docs:*" }))
          .to(mcp("docs:*")),
      ],
      {
        answer: () => ({
          content: [{ type: "text", text: "File not found" }],
          isError: true,
        }),
      },
    );
    const failures: Array<Record<string, unknown>> = [];
    t.ctx.on("plugin:mcp:tool:failed", (event) => {
      failures.push((event as { details: Record<string, unknown> }).details);
    });

    const result = await call("docs_get_document", { id: "gone" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("File not found");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      tool: "docs_get_document",
      proxied: true,
      serverId: "docs",
      remoteTool: "get_document",
    });
  });

  /**
   * @case The route's chain applies: an authorize refuses an anonymous caller before the hop
   * @preconditions Star route with .authorize({ roles: ["admin"] }); a call with no principal
   * @expectedResult The caller receives an isError refusal and the client is never reached
   */
  test("authorize on the proxy route refuses before the hop", async () => {
    await serve([
      craft()
        .id("docs")
        .authorize({ roles: ["admin"] })
        .from(mcp({ proxy: "docs:*" }))
        .to(mcp("docs:*")),
    ]);
    const result = await call("docs_get_document", { id: "1" });
    expect(result.isError).toBe(true);
    expect(dispatches).toEqual([]);
  });

  /**
   * @case The tools filter applies to proxied tools by their exposed name
   * @preconditions Star route over docs; server tools filter allows docs_search only
   * @expectedResult tools/list carries docs_search alone and docs_get_document answers tool-not-found
   */
  test("the tools filter applies to proxied tools", async () => {
    await serve(
      [
        craft()
          .id("docs")
          .from(mcp({ proxy: "docs:*" }))
          .to(mcp("docs:*")),
      ],
      { server: { tools: ["docs_search"] } },
    );
    expect(server.getAvailableTools().map((tool) => tool.name)).toEqual([
      "docs_search",
    ]);
    const hidden = await call("docs_get_document", { id: "1" });
    expect(hidden.isError).toBe(true);
    expect(dispatches).toEqual([]);
  });

  /**
   * @case A cache on a star route serves the read-only tools only, and keeps two tools' equal arguments apart
   * @preconditions Star route with .cache({ when: annotations say read-only }); get_document (read-only) and delete_document (destructive) called twice each with {}, and search (read-only) once with {}
   * @expectedResult get_document reaches the client once; delete_document reaches it twice; search reaches it once rather than hitting get_document's entry
   */
  test("cache when serves read-only tools and tells tools apart", async () => {
    await serve([
      craft()
        .id("docs")
        .cache({
          when: (ex) =>
            (
              ex.headers[McpHeadersKeys.ANNOTATIONS] as
                { readOnlyHint?: boolean } | undefined
            )?.readOnlyHint === true,
        })
        .from(mcp({ proxy: "docs:*" }))
        .to(mcp("docs:*")),
    ]);

    await call("docs_get_document", {});
    await call("docs_get_document", {});
    await call("docs_delete_document", {});
    await call("docs_delete_document", {});
    await call("docs_search", {});

    expect(dispatches.map((d) => d.toolName)).toEqual([
      "get_document",
      "delete_document",
      "delete_document",
      "search",
    ]);
  });

  /**
   * @case Tool call events carry where a proxied call went
   * @preconditions Star route over docs; one successful call
   * @expectedResult plugin:mcp:tool:called and plugin:mcp:tool:completed carry proxied: true, serverId "docs" and remoteTool "get_document"
   */
  test("call events carry proxied provenance", async () => {
    await serve([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .to(mcp("docs:*")),
    ]);
    const events: Array<Record<string, unknown>> = [];
    for (const name of ["called", "completed"] as const) {
      t.ctx.on(`plugin:mcp:tool:${name}`, (event) => {
        events.push({
          name,
          ...(event as { details: Record<string, unknown> }).details,
        });
      });
    }
    await call("docs_get_document", { id: "1" });
    expect(events).toEqual([
      expect.objectContaining({
        name: "called",
        tool: "docs_get_document",
        proxied: true,
        serverId: "docs",
        remoteTool: "get_document",
      }),
      expect.objectContaining({
        name: "completed",
        tool: "docs_get_document",
        proxied: true,
        serverId: "docs",
        remoteTool: "get_document",
      }),
    ]);
  });

  /**
   * @case Two routes proxying the same thing are refused at start
   * @preconditions Two star routes over docs; then two exact routes over docs:get_document
   * @expectedResult Each context fails to start with RC5003 naming both routes
   */
  test("two routes proxying the same tool or client are refused", async () => {
    const start = async (routes: AnyRouteBuilder[]) => {
      const ctx = await testContext()
        .routes(routes)
        .with({
          plugins: [
            mcpPort({
              tools: buildRegistry(),
              stdio: buildManagers(),
              clients: buildClients(),
            }),
          ],
        })
        .build();
      try {
        await ctx.startAndWaitReady();
      } finally {
        await ctx.stop();
      }
    };
    await expect(
      start([
        craft()
          .id("a")
          .from(mcp({ proxy: "docs:*" }))
          .to(mcp("docs:*")),
        craft()
          .id("b")
          .from(mcp({ proxy: "docs" }))
          .to(mcp("docs:*")),
      ]),
    ).rejects.toMatchObject({
      rc: "RC5003",
      message: expect.stringMatching(/"a".*"b"|"b".*"a"/),
    });
    await expect(
      start([
        craft()
          .id("a")
          .from(mcp({ proxy: "docs:get_document" }))
          .to(mcp("docs:get_document")),
        craft()
          .id("b")
          .from(mcp({ proxy: "docs:get_document" }))
          .to(mcp("docs:get_document")),
      ]),
    ).rejects.toMatchObject({
      rc: "RC5003",
      message: expect.stringMatching(/"a".*"b"|"b".*"a"/),
    });
  });

  /**
   * @case A proxy over an unregistered client is refused at start
   * @preconditions Star route over "nope"; only docs and billing are registered
   * @expectedResult The context fails to start with RC5003 naming the registered clients
   */
  test("a proxy over an unregistered client is refused", async () => {
    const ctx = await testContext()
      .routes([
        craft()
          .id("nope")
          .from(mcp({ proxy: "nope:*" }))
          .to(mcp("nope:*")),
      ])
      .with({
        plugins: [
          mcpPort({
            tools: buildRegistry(),
            stdio: buildManagers(),
            clients: buildClients(),
          }),
        ],
      })
      .build();
    try {
      await expect(ctx.startAndWaitReady()).rejects.toMatchObject({
        rc: "RC5003",
      });
    } finally {
      await ctx.stop();
    }
  });

  /**
   * @case Proxy options are validated when mcp() is called
   * @preconditions name with a star proxy; prefix without proxy; ui with proxy; a malformed ref; an invalid name
   * @expectedResult Each throws RC5003 at construction
   */
  test("proxy options are validated at construction", () => {
    expect(() => mcp({ proxy: "docs:*", name: "x" })).toThrow();
    expect(() => mcp({ prefix: "x_" })).toThrow();
    expect(() => mcp({ exclude: ["x"] })).toThrow();
    expect(() =>
      mcp({ proxy: "docs:get_document", exclude: ["search"] }),
    ).toThrow();
    expect(() => mcp({ proxy: "docs:*", exclude: [] })).toThrow();
    expect(() => mcp({ proxy: "docs:*", exclude: ["bad.name"] })).toThrow();
    expect(() =>
      mcp({ proxy: "docs:*", ui: { html: "<p>view</p>" } }),
    ).toThrow();
    expect(() => mcp({ proxy: ":tool" })).toThrow();
    expect(() =>
      mcp({ proxy: "docs:get_document", name: "bad.name" }),
    ).toThrow();
  });

  /**
   * @case The star enricher refuses an exchange that names no tool
   * @preconditions A plain direct route ending in .to(mcp("docs:*")), so no routecraft.mcp.tool header is set
   * @expectedResult The send fails with RC5003 saying the exchange names no tool
   */
  test("the star enricher refuses an exchange without a tool header", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("plain")
          .from<Record<string, unknown>>(
            (await import("@routecraft/routecraft")).direct(),
          )
          .to(mcp("docs:*")),
      ])
      .with({
        plugins: [
          mcpPort({
            tools: buildRegistry(),
            stdio: buildManagers(),
            clients: buildClients(),
          }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    await expect(
      t.client.sendDirect("plain", { id: "1" }),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(dispatches).toEqual([]);
  });
});

describe("an agent's MCP reference to a proxied tool", () => {
  let t: TestContext;

  afterEach(async () => {
    dispatches = [];
    if (t) await t.stop();
  });

  let sessions: MemorySessionStore;

  async function build(routes: AnyRouteBuilder[]): Promise<TestContext> {
    sessions = new MemorySessionStore();
    t = await testContext()
      .routes(routes)
      .with({
        plugins: [
          mcpPort({
            tools: buildRegistry(),
            stdio: buildManagers(),
            clients: buildClients(),
          }),
          sessionsPlugin({ store: sessions }),
        ],
      })
      .with(deferring())
      .build();
    await t.startAndWaitReady();
    return t;
  }

  function handlerContext(
    toolName: string,
    session?: { id: string; agent: string },
  ) {
    return makeFnHandlerContext(
      toolName,
      new AbortController().signal,
      undefined,
      undefined,
      session,
      undefined,
      authorityOf(t.ctx),
    );
  }

  /**
   * @case MCP(server:tool) resolves to the proxying route and runs it
   * @preconditions Star route over docs with a transform before the hop; the agent lists MCP(docs:get_document)
   * @expectedResult The tool keeps its mcp__docs__get_document name, its source names the governing route, and calling it reaches the client with the route's rewritten arguments
   */
  test("the reference runs through the proxying route", async () => {
    await build([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .transform((args) => ({
          ...(args as Record<string, unknown>),
          via: "route",
        }))
        .to(mcp("docs:*")),
    ]);

    const [tool] = tools(["MCP(docs:get_document)"]).resolve(t.ctx);
    expect(tool.name).toBe("mcp__docs__get_document");
    expect(tool.source).toMatchObject({
      kind: "mcp",
      server: "docs",
      tool: "get_document",
      routeId: "docs",
    });
    expect(tool.background).toBeUndefined();

    const result = await tool.handler({ id: "7" }, handlerContext(tool.name));
    expect(dispatches).toEqual([
      {
        serverId: "docs",
        toolName: "get_document",
        args: { id: "7", via: "route" },
      },
    ]);
    expect(result).toBe("raw:docs:get_document");
  });

  /**
   * @case raw: true reaches the client without the route, and says so once
   * @preconditions Same star route; the agent lists { name: "MCP(docs:get_document)", raw: true }
   * @expectedResult The call reaches the client with the arguments as given, the source carries no governing route, and a warning names the bypass
   */
  test("raw: true bypasses the route with a warning", async () => {
    await build([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .transform((args) => ({
          ...(args as Record<string, unknown>),
          via: "route",
        }))
        .to(mcp("docs:*")),
    ]);

    const [tool] = tools([
      { name: "MCP(docs:get_document)", raw: true },
    ]).resolve(t.ctx);
    expect(tool.source).not.toHaveProperty("routeId");
    await tool.handler({ id: "7" }, handlerContext(tool.name));
    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "get_document", args: { id: "7" } },
    ]);
    const warned = t.contextLogger.warn.mock.calls.some(
      (c: unknown[]) => typeof c[1] === "string" && c[1].includes("raw: true"),
    );
    expect(warned).toBe(true);
  });

  /**
   * @case A route that declines leaves the agent with a failed call, not an echoed request
   * @preconditions Star route whose filter drops every exchange
   * @expectedResult The handler rejects with AI2002 and the client is never reached
   */
  test("a declining route fails the agent's call", async () => {
    await build([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .filter(() => false)
        .to(mcp("docs:*")),
    ]);
    const [tool] = tools(["MCP(docs:get_document)"]).resolve(t.ctx);
    await expect(
      tool.handler({ id: "7" }, handlerContext(tool.name)),
    ).rejects.toMatchObject({ rc: "AI2002" });
    expect(dispatches).toEqual([]);
  });

  /**
   * @case A parking route that declines settles the background call as failed, not as the echoed request
   * @preconditions Star route with a filter dropping every exchange before a .defer(); the agent calls the background tool in a session
   * @expectedResult The handle is returned running, the session inbox then carries a failed settlement for that handle with AI2002, and the client is never reached
   */
  test("a declining parking route fails the background call", async () => {
    await build([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .filter(() => false)
        .defer({ ttl: "1h" })
        .to(mcp("docs:*")),
    ]);
    const [tool] = tools(["MCP(docs:get_document)"]).resolve(t.ctx);
    expect(tool.background).toBe(true);
    const session = { id: "s", agent: "bot" };
    const handle = (await tool.handler(
      { id: "7" },
      handlerContext(tool.name, session),
    )) as { status: string; handle: string };
    expect(handle.status).toBe("running");

    const inbox = async () =>
      ((await sessions.get("s"))?.value as { inbox?: unknown[] } | undefined)
        ?.inbox ?? [];
    for (let i = 0; i < 50 && (await inbox()).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await inbox()).toEqual([
      expect.objectContaining({
        handle: handle.handle,
        status: "failed",
        error: expect.objectContaining({ rc: "AI2002" }),
      }),
    ]);
    expect(dispatches).toEqual([]);
  });

  /**
   * @case A tool whose proxy route is declared but not live is withheld
   * @preconditions Star route over docs held back by .enabled(() => false); the agent lists MCP(docs:get_document), then the same with raw: true
   * @expectedResult The plain reference resolves to no tool, with a warning naming the route; raw: true resolves the tool without a governing route
   */
  test("a disabled proxy route withholds the tool", async () => {
    await build([
      craft()
        .id("docs")
        .enabled(() => false)
        .from(mcp({ proxy: "docs:*" }))
        .to(mcp("docs:*")),
    ]);
    expect(tools(["MCP(docs:get_document)"]).resolve(t.ctx)).toEqual([]);
    const warned = t.contextLogger.warn.mock.calls.find(
      (c: unknown[]) => typeof c[1] === "string" && c[1].includes("not live"),
    );
    expect(warned?.[0]).toMatchObject({ route: "docs", tool: "get_document" });
    const [raw] = tools([
      { name: "MCP(docs:get_document)", raw: true },
    ]).resolve(t.ctx);
    expect(raw.source).not.toHaveProperty("routeId");
  });

  /**
   * @case A proxying route that can park makes the tool background
   * @preconditions Star route with a .defer() before the hop
   * @expectedResult The resolved tool is background and its description says so
   */
  test("a parking proxy route makes the tool background", async () => {
    await build([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .defer({ ttl: "1h" })
        .to(mcp("docs:*")),
    ]);
    const [tool] = tools(["MCP(docs:get_document)"]).resolve(t.ctx);
    expect(tool.background).toBe(true);
    expect(tool.description).toContain("runs in the background");
  });

  /**
   * @case A tool the star route excludes is not governed by it
   * @preconditions Star route over docs excluding search; the agent lists MCP(docs:search) and MCP(docs:get_document)
   * @expectedResult search resolves raw, get_document runs through the star route
   */
  test("a tool the star route excludes stays raw for the agent", async () => {
    await build([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*", exclude: ["search"] }))
        .to(mcp("docs:*")),
    ]);
    const [search] = tools(["MCP(docs:search)"]).resolve(t.ctx);
    expect(search.source).not.toHaveProperty("routeId");
    const [fetched] = tools(["MCP(docs:get_document)"]).resolve(t.ctx);
    expect(fetched.source).toMatchObject({ routeId: "docs" });
  });

  /**
   * @case A disabled exact route hands its tool back to the live star route
   * @preconditions Star route over docs and an exact route over get_document held back by .enabled()
   * @expectedResult The agent's MCP(docs:get_document) runs through the star route, not withheld and not raw
   */
  test("a disabled exact route yields to the live star route", async () => {
    await build([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .to(mcp("docs:*")),
      craft()
        .id("fetch")
        .enabled(() => false)
        .from(mcp({ proxy: "docs:get_document" }))
        .to(mcp("docs:get_document")),
    ]);
    const [tool] = tools(["MCP(docs:get_document)"]).resolve(t.ctx);
    expect(tool.source).toMatchObject({ routeId: "docs" });
  });

  /**
   * @case A proxied tool no route covers is offered raw
   * @preconditions An exact route over get_document only
   * @expectedResult MCP(docs:search) resolves raw and its call reaches the client
   */
  test("an uncovered tool stays raw", async () => {
    await build([
      craft()
        .id("fetch")
        .from(mcp({ proxy: "docs:get_document" }))
        .to(mcp("docs:get_document")),
    ]);
    const [tool] = tools(["MCP(docs:search)"]).resolve(t.ctx);
    expect(tool.source).not.toHaveProperty("routeId");
    await tool.handler({ q: "x" }, handlerContext(tool.name));
    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "search", args: { q: "x" } },
    ]);
  });
});
