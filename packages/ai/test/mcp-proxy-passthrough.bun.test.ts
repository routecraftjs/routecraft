import { afterEach, describe, expect, test } from "bun:test";
import { craft, type AnyRouteBuilder } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import type { McpServer } from "../src/mcp/server.ts";
import { mcpPort, mcpServerFor } from "./helpers/mcp-port.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import { mcp } from "../src/index.ts";
import type { McpClientConfig } from "../src/mcp/port.ts";
import type { McpRawToolResult } from "../src/mcp/types.ts";
import {
  openHopResult,
  recordHopResult,
  unalteredHopResult,
} from "../src/mcp/dispatch.ts";

const IMAGE = {
  content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
  _meta: { "vendor/trace": "t-1" },
};
const TWO_TEXTS = {
  content: [
    { type: "text", text: "first" },
    { type: "text", text: "second" },
  ],
};
const STRUCTURED = {
  content: [{ type: "text", text: "Ada (c-1)" }],
  structuredContent: { id: "c-1", name: "Ada" },
  _meta: { "vendor/page": 2 },
};

/** The full result object the server hands back, before the era projection. */
type WireResult = {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

/**
 * A proxied call whose route leaves the hop's result alone answers with the
 * remote's result as published. A route that changes the body keeps
 * today's serialisation.
 */
describe("proxied results pass through when the route leaves them alone", () => {
  let t: TestContext | undefined;
  let server: McpServer | undefined;

  afterEach(async () => {
    await server?.stop().catch(() => undefined);
    server = undefined;
    if (t) await t.stop();
    t = undefined;
  });

  async function serve(routes: AnyRouteBuilder[]): Promise<McpServer> {
    const registry = new McpToolRegistry();
    registry.setToolsForSource("drive", "stdio", [
      { name: "get_thumbnail", inputSchema: { type: "object" } },
      { name: "list_lines", inputSchema: { type: "object" } },
      {
        name: "get_contact",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
        },
      },
      { name: "failing", inputSchema: { type: "object" } },
    ]);
    const answers: Record<string, McpRawToolResult> = {
      get_thumbnail: IMAGE,
      list_lines: TWO_TEXTS,
      get_contact: STRUCTURED,
      failing: {
        content: [{ type: "text", text: "quota exceeded" }],
        isError: true,
      },
    };
    const stdio = new Map([
      [
        "drive",
        {
          callTool: async () => "unused",
          callToolRaw: async (name: string) => answers[name]!,
        },
      ],
    ]);
    const clients = new Map<string, McpClientConfig>([
      ["drive", { transport: "stdio", command: "drive-server" }],
    ]);
    t = await testContext()
      .with({ plugins: [mcpPort({ tools: registry, clients, stdio })] })
      .routes(routes)
      .build();
    await t.startAndWaitReady();
    server = mcpServerFor(t.ctx);
    return server;
  }

  function call(srv: McpServer, tool: string): Promise<WireResult> {
    return (
      srv as unknown as {
        handleToolCall(
          tool: string,
          args: Record<string, unknown>,
          principal: undefined,
        ): Promise<WireResult>;
      }
    ).handleToolCall(tool, {}, undefined);
  }

  const star = (): AnyRouteBuilder =>
    craft()
      .id("drive")
      .from(mcp({ proxy: "drive:*" }))
      .to(mcp("drive:*"));

  /**
   * @case An image block reaches the caller as the remote returned it, with its mimeType and _meta
   * @preconditions Star route with no step after the hop; the remote answers one image block and _meta
   * @expectedResult content is the remote's image block, unchanged, and _meta is carried
   */
  test("an image block and _meta pass through", async () => {
    const result = await call(await serve([star()]), "drive_get_thumbnail");
    expect(result.content).toEqual(IMAGE.content);
    expect(result._meta).toEqual(IMAGE._meta);
    expect(result.isError).toBeUndefined();
  });

  /**
   * @case Several text blocks reach the caller as several blocks
   * @preconditions The remote answers two text blocks
   * @expectedResult content is the two blocks, not one block of their JSON
   */
  test("two text blocks pass through as two", async () => {
    const result = await call(await serve([star()]), "drive_list_lines");
    expect(result.content).toEqual(TWO_TEXTS.content);
  });

  /**
   * @case structuredContent, the remote's own text block beside it, and _meta all pass through
   * @preconditions A tool with an outputSchema answering structuredContent, a human text block and _meta
   * @expectedResult structuredContent is the remote's, the content is its text block rather than the JSON of the structure, and _meta is carried
   */
  test("structuredContent with its text block and _meta pass through", async () => {
    const result = await call(await serve([star()]), "drive_get_contact");
    expect(result.structuredContent).toEqual(STRUCTURED.structuredContent);
    expect(result.content).toEqual(STRUCTURED.content);
    expect(result._meta).toEqual(STRUCTURED._meta);
  });

  /**
   * @case A route that changes the body keeps today's serialisation
   * @preconditions Star route with a transform after the hop that rewrites the result
   * @expectedResult content is one text block of the new body; no _meta
   */
  test("a transformed result is serialised as before", async () => {
    const result = await call(
      await serve([
        craft()
          .id("drive")
          .from(mcp({ proxy: "drive:*" }))
          .to(mcp("drive:*"))
          .transform(() => ({ redacted: true })),
      ]),
      "drive_get_thumbnail",
    );
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ redacted: true }) },
    ]);
    expect(result._meta).toBeUndefined();
  });

  /**
   * @case A route that redacts the structured body in place does not let the remote's text block through
   * @preconditions Exact-shape star route whose .process() deletes a field of the hop's structuredContent body without replacing it
   * @expectedResult structuredContent is the redacted body, the text block is its JSON, and the remote's _meta is not carried
   */
  test("an in-place edit of the body is serialised, not passed through", async () => {
    const result = await call(
      await serve([
        craft()
          .id("drive")
          .from(mcp({ proxy: "drive:*" }))
          .to(mcp("drive:*"))
          .process((ex) => {
            delete (ex.body as { name?: string }).name;
            return ex;
          }),
      ]),
      "drive_get_contact",
    );
    expect(result.structuredContent).toEqual({ id: "c-1" });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ id: "c-1" }) },
    ]);
    expect(JSON.stringify(result)).not.toContain("Ada");
    expect(result._meta).toBeUndefined();
  });

  /**
   * @case A remote isError result is still a failure (AI2003), not passed through
   * @preconditions The remote answers isError with a text block
   * @expectedResult The caller receives isError with the remote's text
   */
  test("an isError result still fails with the remote's text", async () => {
    const result = await call(await serve([star()]), "drive_failing");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("quota exceeded");
  });
});

/** A hop's result is kept only while the server is answering the call it belongs to. */
describe("hop result slots", () => {
  const raw: McpRawToolResult = { content: [{ type: "text", text: "x" }] };

  /**
   * @case A hop with no open slot for its request records nothing
   * @preconditions No slot opened for the request id (an agent call, a hop in a plain route)
   * @expectedResult unalteredHopResult finds nothing for that request
   */
  test("a hop without a slot records nothing", () => {
    const body = { a: 1 };
    recordHopResult("no-slot", body, raw);
    expect(unalteredHopResult("no-slot", body)).toBeUndefined();
  });

  /**
   * @case Closing the slot drops the record
   * @preconditions A slot is opened, a hop records into it, and the slot is closed (the server answered or failed)
   * @expectedResult The record is found while the slot is open and gone once it is closed
   */
  test("closing the slot drops the record", () => {
    const body = { a: 1 };
    const close = openHopResult("req-1");
    recordHopResult("req-1", body, raw);
    expect(unalteredHopResult("req-1", body)).toBe(raw);
    close();
    expect(unalteredHopResult("req-1", body)).toBeUndefined();
  });

  /**
   * @case A hop whose request id is not a string records nothing
   * @preconditions The exchange carries no MCP request header
   * @expectedResult recordHopResult does not throw and stores nothing
   */
  test("a missing request id records nothing", () => {
    expect(() => recordHopResult(undefined, "b", raw)).not.toThrow();
  });
});
