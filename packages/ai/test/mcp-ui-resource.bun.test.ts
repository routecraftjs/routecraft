import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CraftContext, Exchange } from "@routecraft/routecraft";
import { fromFile, type BlockClient } from "../src/index.ts";
import type { McpUiOptions } from "../src/mcp/types.ts";
import {
  loadUiHtml,
  MCP_APP_MIME_TYPE,
  uiReadResult,
  uiResourceUri,
} from "../src/mcp/ui-resource.ts";

describe("MCP Apps view helpers", () => {
  /**
   * @case A server name that is not URI-safe still yields a valid ui:// URI
   * @preconditions Server name with a space and a slash; route id "send-mail"
   * @expectedResult The name is percent-encoded so it cannot split the authority from the path
   */
  test("uiResourceUri encodes the server name", () => {
    expect(uiResourceUri("routecraft", "send-mail")).toBe(
      "ui://routecraft/send-mail",
    );
    expect(uiResourceUri("my server/x", "send-mail")).toBe(
      "ui://my%20server%2Fx/send-mail",
    );
  });

  /**
   * @case A view with no csp or prefersBorder carries no _meta
   * @preconditions ui with only html
   * @expectedResult One content entry with the MCP App MIME type and no _meta key
   */
  test("uiReadResult omits _meta when there is nothing to carry", () => {
    expect(uiReadResult("ui://s/t", { html: "<p/>" }, "<p/>")).toEqual({
      contents: [
        { uri: "ui://s/t", mimeType: MCP_APP_MIME_TYPE, text: "<p/>" },
      ],
    });
  });

  /**
   * @case csp and prefersBorder are carried under _meta.ui
   * @preconditions ui with csp.connectDomains and prefersBorder false
   * @expectedResult _meta.ui holds both, prefersBorder kept even though false
   */
  test("uiReadResult carries csp and prefersBorder", () => {
    const csp = { connectDomains: ["https://api.example.com"] };
    const result = uiReadResult(
      "ui://s/t",
      { html: "<p/>", csp, prefersBorder: false },
      "<p/>",
    );
    expect(result.contents[0]!._meta).toEqual({
      ui: { csp, prefersBorder: false },
    });
  });

  /**
   * @case A loader that resolves to a non-string is refused
   * @preconditions ui.html is a function returning a number, cast past the type
   * @expectedResult loadUiHtml rejects with a TypeError naming the resolved type
   */
  test("loadUiHtml rejects a non-string loader result", async () => {
    const ui = { html: () => 42 as unknown as string };
    await expect(loadUiHtml(ui)).rejects.toThrow(/resolved to number/);
    expect(await loadUiHtml({ html: async () => "<p/>" })).toBe("<p/>");
  });
});

describe("fromFile as a view loader", () => {
  /**
   * @case fromFile() serves both a ui.html loader and a direct block-resolver call
   * @preconditions A temp file; the resolver typed as McpUiOptions["html"] and called with no arguments, then called with the four block-resolver arguments
   * @expectedResult Both compile and both resolve to the file's contents
   */
  test("fits ui.html and keeps the four-argument call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "from-file-"));
    try {
      const path = join(dir, "view.html");
      await writeFile(path, "<p>view</p>");
      const resolver = fromFile(path);
      const html: McpUiOptions["html"] = resolver;

      expect(await loadUiHtml({ html })).toBe("<p>view</p>");
      expect(
        await resolver(
          {} as Exchange<unknown>,
          {} as CraftContext,
          [],
          {} as BlockClient,
        ),
      ).toBe("<p>view</p>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
