/**
 * Wire coverage for the `structuredContent` an MCP tool publishes when its
 * route declares `.output({ body })` (#574).
 *
 * The witness is the installed `@modelcontextprotocol/client`, driven over a
 * real socket. Its `callTool` compiles the `outputSchema` it saw in
 * `tools/list` and validates the reply against it, throwing when a tool
 * advertised a schema and returned no structured result. That client is what
 * rejects the shapes this ticket fixes, so a hand-rolled assertion on the
 * result object would not witness the defect at all: the two sides have to be
 * checked against each other, by the code that does the checking in
 * production.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  craft,
  noop,
  type AnyRouteBuilder,
  type CraftConfig,
} from "@routecraft/routecraft";
import {
  spy,
  suspending,
  testContext,
  type TestContext,
} from "@routecraft/testing";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "../src/mcp/server.ts";
import {
  MCP_LOCAL_TOOL_REGISTRY,
  MCP_PLUGIN_REGISTERED,
} from "../src/mcp/types.ts";
import { mcp } from "../src/index.ts";

const MCP_STORE_KEY =
  MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry;

describe("MCP structured output (#574)", () => {
  let t: TestContext | undefined;
  let server: McpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    if (client) await client.close();
    if (server) await server.stop();
    if (t) await t.stop();
    client = undefined;
    server = undefined;
    t = undefined;
  });

  /**
   * Boot an HTTP MCP server on an ephemeral port and connect the SDK client
   * to it. The client negotiates the 2025 era by default, which is the era
   * whose wire shape requires the SEP-2106 `{ result: ... }` envelope.
   */
  async function connect(
    routes: AnyRouteBuilder[],
    config: CraftConfig = {},
  ): Promise<Client> {
    t = await testContext()
      .store(MCP_STORE_KEY, true)
      .with({ ...config, servers: { default: { host: "127.0.0.1", port: 0 } } })
      .routes(routes)
      .build();
    server = new McpServer(t.ctx, { transport: "http" });
    await server.prepare();
    await t.startAndWaitReady();
    await server.start();

    const connected = new Client({
      name: "structured-output-test",
      version: "1.0.0",
    });
    await connected.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.getHttpPort()}/mcp`),
      ),
    );
    client = connected;
    return connected;
  }

  /**
   * @case A route declaring a string output returns a result the installed client accepts
   * @preconditions mcp()-fronted route with .output({ body: z.string() }) answering "42.50"; the real SDK client, which validates the reply against the outputSchema it read from tools/list
   * @expectedResult callTool resolves rather than throwing "has an output schema but did not return structured content", and the structured result carries the string in the SEP-2106 result envelope the same era applied to the advertisement
   */
  test("a string body is published as a structured result", async () => {
    const connected = await connect([
      craft()
        .id("get-price")
        .description("Answers with a bare price string")
        .output({ body: z.string() })
        .from<{ sku: string }>(mcp())
        .transform(() => "42.50") as AnyRouteBuilder,
    ]);

    const result = await connected.callTool({
      name: "get-price",
      arguments: { sku: "abc" },
    });

    expect(result.structuredContent).toEqual({ result: "42.50" });
    // The text block still renders the author's value, not the envelope: a
    // client reading only `content` must not see a wire concern.
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe("42.50");
  });

  /**
   * @case A route declaring an array output returns a result the installed client accepts
   * @preconditions mcp()-fronted route with .output({ body: z.array(z.string()) }); the real SDK client
   * @expectedResult callTool resolves and the array arrives inside the result envelope, the array root being non-object exactly as a primitive root is
   */
  test("an array body is published as a structured result", async () => {
    const connected = await connect([
      craft()
        .id("list-skus")
        .description("Answers with a bare array")
        .output({ body: z.array(z.string()) })
        .from<{ q: string }>(mcp())
        .transform(() => ["a", "b"]) as AnyRouteBuilder,
    ]);

    const result = await connected.callTool({
      name: "list-skus",
      arguments: { q: "x" },
    });

    expect(result.structuredContent).toEqual({ result: ["a", "b"] });
  });

  /**
   * @case An object body is unchanged by the fix
   * @preconditions mcp()-fronted route with .output({ body: z.object(...) }); the real SDK client
   * @expectedResult The structured result is the body itself with no envelope and the advertised schema keeps its object root, so an existing client sees byte-identical bytes to before #574
   */
  test("an object body is published unwrapped, as before", async () => {
    const connected = await connect([
      craft()
        .id("get-order")
        .description("Answers with an object")
        .output({ body: z.object({ paid: z.boolean() }) })
        .from<{ q: string }>(mcp())
        .transform(() => ({ paid: true })) as AnyRouteBuilder,
    ]);

    const { tools } = await connected.listTools();
    expect(tools[0]!.outputSchema).toMatchObject({
      type: "object",
      properties: { paid: { type: "boolean" } },
    });

    const result = await connected.callTool({
      name: "get-order",
      arguments: { q: "x" },
    });

    expect(result.structuredContent).toEqual({ paid: true });
  });

  /**
   * @case A suspendable tool's acknowledgment reaches the client in the shape its own advertisement promises
   * @preconditions mcp()-fronted route with .output() and a reachable .suspend(), so tools/list advertises a oneOf root; the real SDK client
   * @expectedResult The park answers rather than failing the call, and the acknowledgment arrives inside the result envelope, matching the wrap the same era applies to the oneOf-rooted advertisement
   */
  test("a suspension acknowledgment matches the advertised union", async () => {
    const connected = await connect(
      [
        craft()
          .id("approve-payout")
          .description("Parks for approval before paying out")
          .output({ body: z.object({ paid: z.boolean() }) })
          .from<{ amount: number }>(mcp())
          .suspend({ schema: z.object({ approved: z.boolean() }) })
          .transform(() => ({ paid: true })) as AnyRouteBuilder,
      ],
      suspending(),
    );

    const { tools } = await connected.listTools();
    // The era wraps a oneOf root on the advertisement side too; pin both so a
    // drift between them cannot pass.
    expect(tools[0]!.outputSchema).toMatchObject({
      type: "object",
      required: ["result"],
    });

    const result = await connected.callTool({
      name: "approve-payout",
      arguments: { amount: 1 },
    });

    expect(result.isError).toBeFalsy();
    const envelope = result.structuredContent as {
      result: Record<string, unknown>;
    };
    expect(envelope.result).toMatchObject({ status: "suspended" });
    expect(typeof envelope.result["token"]).toBe("string");
  });

  /**
   * @case A route that declares no output publishes no structured result
   * @preconditions mcp()-fronted route without .output() answering a plain object; the real SDK client
   * @expectedResult No outputSchema is advertised and no structuredContent is sent, so nothing obliges a run to carry a structured result it never promised
   */
  test("a route without .output() advertises and publishes nothing", async () => {
    const connected = await connect([
      craft()
        .id("fire-and-forget")
        .description("Declares no output")
        .from<{ q: string }>(mcp())
        .transform(() => ({ ok: true }))
        .to(noop()) as AnyRouteBuilder,
    ]);

    const { tools } = await connected.listTools();
    expect(tools[0]!.outputSchema).toBeUndefined();

    const result = await connected.callTool({
      name: "fire-and-forget",
      arguments: { q: "x" },
    });
    expect(result.structuredContent).toBeUndefined();
  });

  /**
   * @case The advertisement travels with the value instead of being looked up again
   * @preconditions mcp()-fronted suspendable route (oneOf root, so the wrap depends entirely on the schema); handleToolCall driven directly, then the route's entry deleted from the live registry as an unsubscribe would
   * @expectedResult The result carries the advertised schema it was produced under, and still carries it after the entry is gone, so a route that unsubscribes while parked cannot have its acknowledgment published against a schema the server can no longer find
   */
  test("the result carries the schema it was produced under", async () => {
    t = await testContext()
      .store(MCP_STORE_KEY, true)
      .with(suspending())
      .routes([
        craft()
          .id("approve-payout")
          .description("Parks for approval before paying out")
          .output({ body: z.object({ paid: z.boolean() }) })
          .from<{ amount: number }>(mcp())
          .suspend({ schema: z.object({ approved: z.boolean() }) })
          .transform(() => ({ paid: true })) as AnyRouteBuilder,
      ])
      .build();
    await t.startAndWaitReady();
    server = new McpServer(t.ctx);

    const testable = server as unknown as {
      handleToolCall(
        tool: string,
        args: Record<string, unknown>,
        principal: undefined,
      ): Promise<{ advertisedOutputSchema?: Record<string, unknown> }>;
    };
    const result = await testable.handleToolCall(
      "approve-payout",
      { amount: 1 },
      undefined,
    );

    // Plain reads rather than toMatchObject: bun:test rewrites matched fields
    // on the actual object, which would make the second assertion vacuous.
    const carried = result.advertisedOutputSchema;
    expect(Array.isArray(carried?.["oneOf"])).toBe(true);

    const registry = t.ctx.getStore(
      MCP_LOCAL_TOOL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as Map<string, unknown> | undefined;
    registry?.delete("approve-payout");

    expect(result.advertisedOutputSchema).toBe(carried);
    expect(Array.isArray(result.advertisedOutputSchema?.["oneOf"])).toBe(true);
  });

  /**
   * @case The author's contract stays unwrapped even though the wire is wrapped
   * @preconditions mcp()-fronted route with .output({ body: z.string() }) whose terminal step asserts on the body it was handed
   * @expectedResult The route sees the bare string, never { result: ... }: the envelope is applied at the wire seam and never reaches the author's declared contract
   */
  test("the result envelope never reaches the route's own body", async () => {
    const observed = spy<string>();
    const connected = await connect([
      craft()
        .id("observe-body")
        .description("Records the body it publishes")
        .output({ body: z.string() })
        .from<{ q: string }>(mcp())
        .transform(() => "plain")
        .tap(observed) as AnyRouteBuilder,
    ]);

    await connected.callTool({ name: "observe-body", arguments: { q: "x" } });

    expect(observed.receivedBodies()).toEqual(["plain"]);
  });
});
