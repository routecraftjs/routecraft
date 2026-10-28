import { afterEach, describe, expect, test } from "bun:test";
import { craft, type AnyRouteBuilder } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import type { McpServer } from "../src/mcp/server.ts";
import { mcpPort, mcpServerFor } from "./helpers/mcp-port.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import { mcp } from "../src/index.ts";
import type { McpClientConfig } from "../src/mcp/port.ts";
import type { McpRawToolResult } from "../src/mcp/types.ts";

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
