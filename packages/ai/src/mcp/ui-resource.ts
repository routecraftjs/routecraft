import type { ReadResourceResult } from "@modelcontextprotocol/server";
import type { McpUiOptions } from "./types.ts";

/** MIME type the MCP Apps extension requires on a view resource. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * The `ui://` URI a tool's view is served at. Derived from the server and
 * route identities rather than configured, so it cannot collide with
 * another route's view or drift from the tool that advertises it.
 */
export function uiResourceUri(serverName: string, endpoint: string): string {
  return `ui://${encodeURIComponent(serverName)}/${endpoint}`;
}

/**
 * Resolve a view's HTML: the string as given, or what its loader returns.
 * Throws when the loader throws or resolves to anything but a string.
 */
export async function loadUiHtml(ui: McpUiOptions): Promise<string> {
  const html = typeof ui.html === "string" ? ui.html : await ui.html();
  if (typeof html !== "string") {
    throw new TypeError(
      `ui.html resolved to ${typeof html}, expected an HTML string`,
    );
  }
  return html;
}

/**
 * The `resources/read` result for a loaded view, carrying `csp` and
 * `prefersBorder` under `_meta.ui` where the MCP Apps extension reads them.
 */
export function uiReadResult(
  uri: string,
  ui: McpUiOptions,
  html: string,
): ReadResourceResult {
  const meta: Record<string, unknown> = {};
  if (ui.csp !== undefined) meta["csp"] = ui.csp;
  if (ui.prefersBorder !== undefined) meta["prefersBorder"] = ui.prefersBorder;
  return {
    contents: [
      {
        uri,
        mimeType: MCP_APP_MIME_TYPE,
        text: html,
        ...(Object.keys(meta).length > 0 ? { _meta: { ui: meta } } : {}),
      },
    ],
  };
}
