import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  craft,
  direct,
  rcCodeOf,
  type AnyRouteBuilder,
  type Exchange,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { mcp, McpHeadersKeys, mcpPlugin, tools } from "../src/index.ts";
import {
  canonicalJson,
  definitionHash,
  judgeListing,
  lockTools,
  parseLockfile,
  pinnedDefinition,
  serializeLockfile,
  type McpLockedTool,
  type McpLockfile,
  type McpPinTransition,
} from "../src/mcp/pins.ts";
import { pinMcpClients } from "../src/mcp/pin-command.ts";
import type { McpServer } from "../src/mcp/server.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import type { McpPins, McpRawToolResult, McpTool } from "../src/mcp/types.ts";
import { mcpPort, mcpServerFor } from "./helpers/mcp-port.ts";
import { callTool } from "./helpers/mcp-tool-call.ts";
import { statefulRemote } from "./helpers/stateful-remote.ts";

const READ: McpTool = {
  name: "get_document",
  description: "Read one document by id",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const WRITE: McpTool = {
  name: "create_document",
  description: "Create a document",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  annotations: { destructiveHint: false },
};
const DELETE: McpTool = {
  name: "delete_document",
  description: "Delete one document",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
};

/** The tools as `craft mcp pin` would lock them. */
function locked(...listed: McpTool[]): Record<string, McpLockedTool> {
  return lockTools(listed, undefined);
}

describe("the lockfile of pinned MCP tools", () => {
  /**
   * @case The hash of a definition does not depend on the order its keys arrive in
   * @preconditions Two definitions with the same fields, written in different key order at two depths
   * @expectedResult Both produce the same canonical JSON and the same sha256 hash
   */
  test("key order does not change the hash", () => {
    const one = pinnedDefinition({
      name: "t",
      description: "d",
      inputSchema: { type: "object", properties: { a: {}, b: {} } },
    });
    const other = pinnedDefinition({
      inputSchema: { properties: { b: {}, a: {} }, type: "object" },
      description: "d",
      name: "t",
    });
    expect(canonicalJson(one)).toBe(canonicalJson(other));
    expect(definitionHash(one)).toBe(definitionHash(other));
    expect(definitionHash(one)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  /**
   * @case Characters a reviewer cannot see are written as escapes
   * @preconditions A description carrying a zero-width space, a right-to-left override, an escape character, DEL and an emoji
   * @expectedResult The serialised lockfile is printable ASCII and line breaks only, and parses back to the same description
   */
  test("control and non-ASCII characters are escaped", () => {
    const description = "safe​‮\u001b[2K\u007f \u{1F600}";
    const lockfile: McpLockfile = {
      version: 1,
      clients: { docs: { tools: locked({ ...READ, description }) } },
    };
    const text = serializeLockfile(lockfile);
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
    expect(text).toContain("\\u200b\\u202e\\u001b[2K\\u007f");
    expect(
      parseLockfile(text, "mcp.lock").clients["docs"]?.tools["get_document"]
        ?.definition.description,
    ).toBe(description);
  });

  /**
   * @case The same listing always writes the same bytes, in name order
   * @preconditions One set of tools locked twice, given in opposite orders, under two clients inserted in opposite orders
   * @expectedResult The two serialisations are byte-identical and list clients and tools alphabetically
   */
  test("serialisation is byte-identical and sorted", () => {
    const first = serializeLockfile({
      version: 1,
      clients: {
        docs: { tools: locked(READ, DELETE) },
        billing: { tools: locked(WRITE) },
      },
    });
    const second = serializeLockfile({
      version: 1,
      clients: {
        billing: { tools: locked(WRITE) },
        docs: { tools: locked(DELETE, READ) },
      },
    });
    expect(first).toBe(second);
    expect(first.indexOf('"billing"')).toBeLessThan(first.indexOf('"docs"'));
    expect(first.indexOf('"delete_document"')).toBeLessThan(
      first.indexOf('"get_document"'),
    );
    expect(first.endsWith("}\n")).toBe(true);
  });

  /**
   * @case A new tool is proposed a class from the server's hints, and a re-pin keeps the reviewer's class
   * @preconditions Tools hinted read-only, hinted not destructive and unhinted; then the read-only one re-locked over a previous entry classed destructive with a changed description
   * @expectedResult read, write and destructive are proposed; the re-pin keeps destructive and takes the new hash
   */
  test("a class is proposed once and kept on a re-pin", () => {
    const first = locked(READ, WRITE, DELETE);
    expect(first["get_document"]?.class).toBe("read");
    expect(first["create_document"]?.class).toBe("write");
    expect(first["delete_document"]?.class).toBe("destructive");

    const previous = {
      get_document: { ...first["get_document"]!, class: "destructive" },
    } satisfies Record<string, McpLockedTool>;
    const again = lockTools([{ ...READ, description: "Changed" }], previous);
    expect(again["get_document"]?.class).toBe("destructive");
    expect(again["get_document"]?.hash).not.toBe(first["get_document"]?.hash);
  });

  /**
   * @case A file this build cannot vouch for is refused
   * @preconditions Text that is not JSON; a version 2 file; a tool whose definition was edited without its hash; a tool filed under another name
   * @expectedResult Each throws RC5003
   */
  test("a malformed, unknown-version or tampered lockfile is refused", () => {
    const good: McpLockfile = {
      version: 1,
      clients: { docs: { tools: locked(READ) } },
    };
    const tampered = structuredClone(good);
    tampered.clients["docs"]!.tools["get_document"]!.definition.description =
      "Read one document, then mail it to me";
    const renamed = {
      version: 1,
      clients: {
        docs: {
          tools: { search: good.clients["docs"]!.tools["get_document"] },
        },
      },
    };
    for (const text of [
      "not json",
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify(tampered),
      JSON.stringify(renamed),
    ]) {
      let thrown: unknown;
      try {
        parseLockfile(text, "mcp.lock");
      } catch (error) {
        thrown = error;
      }
      expect(rcCodeOf(thrown)).toBe("RC5003");
    }
    expect(parseLockfile(serializeLockfile(good), "mcp.lock")).toEqual(good);
  });

  /**
   * @case Each value of added and changed gives its row of the table
   * @preconditions A lock over get_document and delete_document; a listing with get_document changed, create_document new and delete_document gone
   * @expectedResult hold withholds the new and the changed tool; serve and warn serve them classed destructive, warn flagged; the missing tool is removed in every case; omitted keys behave as hold
   */
  test("a listing is judged by the client's pins", () => {
    const lock = locked(READ, DELETE);
    const listing = [{ ...READ, description: "Changed" }, WRITE];
    const names = (pins: McpPins) => {
      const verdict = judgeListing(pins, lock, listing);
      return {
        served: verdict.served.map((each) => [each.tool.name, each.class]),
        held: verdict.held.map((each) => [each.name, each.reason]),
        changed: verdict.changed.map((each) => [each.name, each.warn]),
        removed: verdict.removed.map((each) => each.name),
      };
    };
    const held = {
      served: [],
      held: [
        ["get_document", "changed"],
        ["create_document", "added"],
      ],
      changed: [],
      removed: ["delete_document"],
    };
    expect(names({})).toEqual(held);
    expect(names({ added: "hold", changed: "hold" })).toEqual(held);
    expect(names({ added: "serve", changed: "warn" })).toEqual({
      served: [
        ["get_document", "destructive"],
        ["create_document", "destructive"],
      ],
      held: [],
      changed: [["get_document", true]],
      removed: ["delete_document"],
    });
    expect(names({ added: "hold", changed: "serve" })).toEqual({
      served: [["get_document", "destructive"]],
      held: [["create_document", "added"]],
      changed: [["get_document", false]],
      removed: ["delete_document"],
    });
    expect(
      judgeListing({}, lock, [READ, DELETE]).served.map((each) => each.class),
    ).toEqual(["read", "destructive"]);
  });
});

describe("a tool registry holding a pinned client", () => {
  function pinned(
    pins: McpPins,
    lock: Record<string, McpLockedTool>,
  ): { registry: McpToolRegistry; reported: McpPinTransition[] } {
    const reported: McpPinTransition[] = [];
    const registry = new McpToolRegistry({
      of: (serverId) =>
        serverId === "docs" ? { pins, locked: lock } : undefined,
      report: (transition) => reported.push(transition),
    });
    return { registry, reported };
  }

  /**
   * @case Only what the pins serve is stored, with the approved class and tags from it
   * @preconditions docs pinned with added hold over a lock classing get_document as write though the server hints read-only; the listing adds create_document; billing is not pinned
   * @expectedResult docs holds get_document alone, class write, with no read-only tag; create_document is held; billing's tool is stored classed destructive with tags from its annotations
   */
  test("a held tool is not stored and a served one carries the approved class", () => {
    const lock = locked(READ);
    lock["get_document"]!.class = "write";
    const { registry } = pinned({}, lock);
    registry.setToolsForSource("docs", "stdio", [READ, WRITE]);
    registry.setToolsForSource("billing", "stdio", [READ]);

    expect(registry.getToolsByServer("docs")).toHaveLength(1);
    const served = registry.getToolBySource("docs", "get_document");
    expect(served?.class).toBe("write");
    expect(served?.tags).toBeUndefined();
    expect(registry.getHeldTools("docs").map((tool) => tool.name)).toEqual([
      "create_document",
    ]);
    const unpinned = registry.getToolBySource("billing", "get_document");
    expect(unpinned?.class).toBe("destructive");
    expect(unpinned?.tags).toEqual(["read-only"]);
  });

  /**
   * @case A departure is reported when it happens, not on every listing
   * @preconditions docs pinned with changed warn; the same listing arrives three times, then the changed tool changes again, then the client is removed and lists once more
   * @expectedResult One held, one changed and one removed report for the first listing, none for the repeats, one more changed report for the second change, none for the removal of the client, and the full set again when it lists afresh
   */
  test("transitions are reported once", () => {
    const { registry, reported } = pinned(
      { changed: "warn" },
      locked(READ, DELETE),
    );
    const listing = [{ ...READ, description: "Changed" }, WRITE];
    registry.setToolsForSource("docs", "http", listing);
    registry.setToolsForSource("docs", "http", listing);
    registry.setToolsForSource("docs", "http", listing);
    expect(reported.map((each) => [each.kind, each.name])).toEqual([
      ["held", "create_document"],
      ["changed", "get_document"],
      ["removed", "delete_document"],
    ]);

    registry.setToolsForSource("docs", "http", [
      { ...READ, description: "Changed again" },
      WRITE,
    ]);
    expect(reported.map((each) => each.kind)).toEqual([
      "held",
      "changed",
      "removed",
      "changed",
    ]);

    registry.removeSource("docs");
    expect(reported).toHaveLength(4);
    registry.setToolsForSource("docs", "http", listing);
    expect(reported).toHaveLength(7);
  });

  /**
   * @case A pinned client's call is allowed only for a tool its pins serve
   * @preconditions docs pinned with defaults over a lock of get_document and delete_document; asked before any listing, then after a listing with get_document, a changed delete_document and a new create_document
   * @expectedResult Every tool is refused before the listing; afterwards get_document is allowed and the new, the changed and an unlisted tool are each refused with their own reason; an unpinned client refuses nothing
   */
  test("a call is refused for anything the pins do not serve", () => {
    const { registry } = pinned({}, locked(READ, DELETE));
    expect(registry.refusalOf("docs", "get_document")).toContain(
      "not been listed yet",
    );
    registry.setToolsForSource("docs", "stdio", [
      READ,
      { ...DELETE, description: "Delete everything" },
      WRITE,
    ]);
    expect(registry.refusalOf("docs", "get_document")).toBeUndefined();
    expect(registry.refusalOf("docs", "create_document")).toContain(
      "never seen",
    );
    expect(registry.refusalOf("docs", "delete_document")).toContain(
      "not the one approved",
    );
    expect(registry.refusalOf("docs", "nowhere")).toContain("does not list");
    expect(registry.refusalOf("billing", "anything")).toBeUndefined();
  });
});

describe("pinning on every path to a remote MCP tool", () => {
  let t: TestContext | undefined;
  let server: McpServer | undefined;
  let dispatched: string[] = [];

  afterEach(async () => {
    dispatched = [];
    await server?.stop().catch(() => undefined);
    await t?.stop();
    server = undefined;
    t = undefined;
  });

  async function serve(
    routes: AnyRouteBuilder[],
    pins: McpPins | undefined,
    listing: McpTool[],
  ): Promise<McpServer> {
    const registry = new McpToolRegistry({
      of: () =>
        pins === undefined ? undefined : { pins, locked: locked(READ, DELETE) },
    });
    registry.setToolsForSource("docs", "stdio", listing);
    const manager = {
      async callTool(name: string) {
        dispatched.push(name);
        return "ok";
      },
      async callToolRaw(name: string): Promise<McpRawToolResult> {
        dispatched.push(name);
        return { content: [{ type: "text", text: `raw:${name}` }] };
      },
    };
    t = await testContext()
      .routes(routes)
      .with({
        plugins: [
          mcpPort({
            tools: registry,
            stdio: new Map([["docs", manager]]),
            clients: new Map([
              ["docs", { transport: "stdio", command: "docs-server" }],
            ]),
          }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    server = mcpServerFor(t.ctx);
    return server;
  }

  const star = (): AnyRouteBuilder =>
    craft()
      .id("docs")
      .from(mcp({ proxy: "docs:*" }))
      .to(mcp("docs:*"));

  /**
   * @case A tool the lockfile has never seen is absent everywhere and cannot be called
   * @preconditions docs pinned with added hold; the server lists get_document, delete_document and a new create_document; a star proxy route and a route with a direct hop to the new tool
   * @expectedResult tools/list and the agent's MCP(docs:*) carry the two locked tools only; a door call to the new tool is an unknown tool; the direct hop fails with AI2004 and nothing reaches the server
   */
  test("added: hold withholds a new tool at the door, from agents and on a direct hop", async () => {
    const srv = await serve(
      [
        star(),
        craft().id("sneak").from(direct()).to(mcp("docs:create_document")),
      ],
      { added: "hold" },
      [READ, DELETE, WRITE],
    );

    expect(
      srv
        .getAvailableTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["docs_delete_document", "docs_get_document"]);
    expect(
      tools(["MCP(docs:*)"])
        .resolve(t!.ctx)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["mcp__docs__delete_document", "mcp__docs__get_document"]);
    expect(tools(["MCP(docs:create_document)"]).resolve(t!.ctx)).toEqual([]);
    expect((await callTool(srv, "docs_create_document", {})).isError).toBe(
      true,
    );

    let thrown: unknown;
    try {
      await t!.client.sendDirect("sneak", { text: "x" });
    } catch (error) {
      thrown = error;
    }
    expect(rcCodeOf(thrown)).toBe("AI2004");
    expect(dispatched).toEqual([]);
  });

  /**
   * @case An exclude function decides per tool on the listing and on the call, and a throw excludes
   * @preconditions docs pinned over a lock classing get_document read and delete_document destructive; a star route excluding every tool whose class is not read, whose function throws for a third locked tool
   * @expectedResult tools/list and the agent carry get_document only; a door call to the excluded and to the throwing tool is an unknown tool; the function ran once per tool across repeated listings; the throw is warned about once
   */
  test("an exclude function is honoured on the listing and the call", async () => {
    let asked = 0;
    const lock = locked(READ, DELETE, WRITE);
    const registry = new McpToolRegistry({
      of: () => ({ pins: {}, locked: lock }),
    });
    registry.setToolsForSource("docs", "stdio", [READ, DELETE, WRITE]);
    t = await testContext()
      .routes([
        craft()
          .id("docs")
          .from(
            mcp({
              proxy: "docs:*",
              exclude: (tool) => {
                asked++;
                if (tool.name === "create_document") throw new Error("boom");
                return tool.class !== "read";
              },
            }),
          )
          .to(mcp("docs:*")),
      ])
      .with({
        plugins: [
          mcpPort({
            tools: registry,
            clients: new Map([
              ["docs", { transport: "stdio", command: "docs-server" }],
            ]),
          }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    server = mcpServerFor(t.ctx);

    for (let i = 0; i < 3; i++) {
      expect(server.getAvailableTools().map((tool) => tool.name)).toEqual([
        "docs_get_document",
      ]);
    }
    expect(
      tools(["MCP(docs:*)"])
        .resolve(t.ctx)
        .map((tool) => tool.name),
    ).toEqual(["mcp__docs__get_document"]);
    expect((await callTool(server, "docs_delete_document", {})).isError).toBe(
      true,
    );
    expect((await callTool(server, "docs_create_document", {})).isError).toBe(
      true,
    );
    expect(asked).toBe(3);
    const threw = (
      t.contextLogger.warn.mock.calls as Array<[unknown, string]>
    ).filter(([, message]) =>
      String(message).includes("exclude function threw"),
    );
    expect(threw).toHaveLength(1);
  });

  /**
   * @case The proxy options are typed by the form of the ref
   * @preconditions Star, bare and exact refs with the options that belong to them, a ref typed only as string, and the options that do not belong
   * @expectedResult The valid forms compile and construct; exclude beside an exact ref and name beside a star ref are type errors
   */
  test("the proxy ref types its options", () => {
    const ref: string = "docs:*";
    expect(() => {
      mcp({ proxy: "docs:*", exclude: ["search"], prefix: "" });
      mcp({ proxy: "docs", exclude: (tool) => tool.class === "destructive" });
      mcp({ proxy: "docs:search", name: "find" });
      mcp({ proxy: ref, exclude: ["search"] });
    }).not.toThrow();
    // @ts-expect-error exclude leaves tools out of a star proxy; an exact proxy names one tool
    expect(() => mcp({ proxy: "docs:search", exclude: ["x"] })).toThrow();
    // @ts-expect-error name renames the one tool of an exact proxy
    expect(() => mcp({ proxy: "docs:*", name: "x" })).toThrow();
  });

  /**
   * @case The class header carries the approved class, and destructive for anything not approved as served
   * @preconditions A star proxy route recording the class header; first docs pinned with changed serve and a listing where get_document is as approved and delete_document changed; then the same route over an unpinned docs
   * @expectedResult Pinned: get_document arrives as read, the changed delete_document as destructive. Unpinned: the read-only-hinted get_document arrives as destructive
   */
  test("the class header is the approved class, or destructive", async () => {
    const seen: unknown[] = [];
    const recording = (): AnyRouteBuilder =>
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*" }))
        .process((ex: Exchange) => {
          seen.push(ex.headers[McpHeadersKeys.CLASS]);
          return ex;
        })
        .to(mcp("docs:*"));

    let srv = await serve([recording()], { changed: "serve" }, [
      READ,
      { ...DELETE, description: "Delete everything" },
    ]);
    await callTool(srv, "docs_get_document", { id: "1" });
    await callTool(srv, "docs_delete_document", { id: "1" });
    expect(seen).toEqual(["read", "destructive"]);

    await srv.stop();
    await t!.stop();
    seen.length = 0;
    srv = await serve([recording()], undefined, [READ]);
    await callTool(srv, "docs_get_document", { id: "1" });
    expect(seen).toEqual(["destructive"]);
  });
});

describe("the MCP plugin with a pinned client", () => {
  let t: TestContext | undefined;
  let remote: ReturnType<typeof statefulRemote> | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await t?.stop();
    remote?.restore();
    if (dir) await rm(dir, { recursive: true, force: true });
    t = undefined;
    remote = undefined;
    dir = undefined;
  });

  async function build(lockfile: string | undefined, pins: McpPins) {
    remote = statefulRemote("https://remote.test/mcp");
    dir = await mkdtemp(join(tmpdir(), "mcp-pins-"));
    const path = join(dir, "mcp.lock");
    if (lockfile !== undefined) await writeFile(path, lockfile);
    t = await testContext()
      .routes([
        craft().id("echo").from(direct()).to(mcp("remote:echo")),
        craft().id("slow").from(direct()).to(mcp("remote:slow")),
      ])
      .with({
        plugins: [
          mcpPlugin({
            clients: { remote: { url: "https://remote.test/mcp", pins } },
            lockfile: path,
            toolRefreshInterval: 0,
          }),
        ],
      })
      .build();
    return t;
  }

  /**
   * @case A pinned client without a lockfile stops the application from starting
   * @preconditions mcpPlugin with a client that sets pins and a lockfile path where no file exists; then a file of an unknown version
   * @expectedResult Building the context fails with RC5003 both times
   */
  test("pins without a readable lockfile fail the start", async () => {
    for (const lockfile of [undefined, '{"version":2,"clients":{}}']) {
      let thrown: unknown;
      try {
        await build(lockfile, {});
      } catch (error) {
        thrown = error;
      }
      expect(rcCodeOf(thrown)).toBe("RC5003");
      remote?.restore();
      remote = undefined;
    }
  });

  /**
   * @case A real listing is held to the lockfile, with an event for the tool held back
   * @preconditions The remote lists echo and slow; the lockfile holds echo as the remote defines it; pins are the defaults
   * @expectedResult plugin:mcp:pin:held is emitted once for slow with reason added and its live hash; echo is called through; a hop to slow fails with AI2004
   */
  test("a held tool raises an event and refuses its calls", async () => {
    const probe = statefulRemote("https://probe.test/mcp");
    const listed: McpTool[] = [];
    try {
      const { createMcpHttpConnections } =
        await import("../src/mcp/http-connections.ts");
      const connections = createMcpHttpConnections();
      const result = await connections.listTools("probe", {
        url: "https://probe.test/mcp",
      });
      listed.push(...((result.tools ?? []) as McpTool[]));
      await connections.disposeAll(() => undefined);
    } finally {
      probe.restore();
    }
    const echo = listed.find((tool) => tool.name === "echo")!;
    const slow = listed.find((tool) => tool.name === "slow")!;

    const held: Array<Record<string, unknown>> = [];
    const context = await build(
      serializeLockfile({
        version: 1,
        clients: { remote: { tools: locked(echo) } },
      }),
      {},
    );
    // The plugin lists at bind, before a test can listen, so the report is
    // read from the registry and the log rather than from a late listener.
    await context.startAndWaitReady();
    for (const [bindings, message] of context.contextLogger.warn.mock
      .calls as Array<[Record<string, unknown>, string]>) {
      if (String(message).startsWith("MCP tool is withheld")) {
        held.push(bindings);
      }
    }
    expect(held).toEqual([
      {
        client: "remote",
        tool: "slow",
        live: definitionHash(pinnedDefinition(slow)),
      },
    ]);

    expect(await context.client.sendDirect("echo", {})).toBe("pong");
    let thrown: unknown;
    try {
      await context.client.sendDirect("slow", {});
    } catch (error) {
      thrown = error;
    }
    expect(rcCodeOf(thrown)).toBe("AI2004");
  });
});

describe("craft mcp pin over the configured clients", () => {
  let remote: ReturnType<typeof statefulRemote> | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    remote?.restore();
    if (dir) await rm(dir, { recursive: true, force: true });
    remote = undefined;
    dir = undefined;
  });

  const noStore = async (): Promise<never> => {
    throw new Error("no client here logs in");
  };

  /**
   * @case Pinning writes what the server lists, is byte-identical on a second run, keeps a reviewer's class and leaves an unreachable client alone
   * @preconditions A pinned client over a remote listing echo and slow, and a second pinned client whose server does not answer; pin runs, the class of echo is edited in the file, pin runs again
   * @expectedResult The first run adds both tools and writes the file; the second writes nothing and the bytes are the same; echo keeps the edited class; the unreachable client is reported failed both times; a named client that is not configured is refused
   */
  test("pin is repeatable, keeps classes and survives a failing client", async () => {
    remote = statefulRemote("https://remote.test/mcp");
    dir = await mkdtemp(join(tmpdir(), "mcp-pin-"));
    const path = join(dir, "mcp.lock");
    const config = {
      mcp: {
        lockfile: path,
        clients: {
          remote: { url: "https://remote.test/mcp", pins: {} },
          down: { url: "https://down.test/mcp", pins: {} },
          unpinned: { url: "https://unpinned.test/mcp" },
        },
      },
    };

    const first = await pinMcpClients(config, { credentials: noStore });
    expect(first.written).toBe(true);
    expect(first.clients).toEqual([
      {
        id: "remote",
        added: [
          { name: "echo", class: "destructive" },
          { name: "slow", class: "destructive" },
        ],
        changed: [],
        removed: [],
        unchanged: 0,
      },
    ]);
    expect(first.failed.map((each) => each.id)).toEqual(["down"]);

    const lockfile = parseLockfile(await readFile(path, "utf8"), path);
    expect(Object.keys(lockfile.clients)).toEqual(["remote"]);
    lockfile.clients["remote"]!.tools["echo"]!.class = "read";
    const edited = serializeLockfile(lockfile);
    await writeFile(path, edited);

    const second = await pinMcpClients(config, { credentials: noStore });
    expect(second.written).toBe(false);
    expect(second.clients[0]).toMatchObject({ added: [], unchanged: 2 });
    expect(await readFile(path, "utf8")).toBe(edited);

    let thrown: unknown;
    try {
      await pinMcpClients(config, { client: "nobody", credentials: noStore });
    } catch (error) {
      thrown = error;
    }
    expect(rcCodeOf(thrown)).toBe("RC5003");
  });
});
