import {
  direct,
  type CraftContext,
  type Exchange,
  type ExchangeHeaders,
  type Source,
} from "@routecraft/routecraft";
import type { McpServerOptions } from "./types.ts";
import { MCP_PLUGIN_REGISTERED } from "./types.ts";

/**
 * Internal server: .from(mcp(endpoint, options)). Delegates to direct(); requires MCP plugin.
 * Exported only for use by McpAdapter; not re-exported from package.
 */
export class McpServer<T = unknown> implements Source<T> {
  readonly adapterId = "routecraft.adapter.mcp.source";

  constructor(
    private readonly endpoint: string,
    private readonly options: McpServerOptions,
  ) {}

  async subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    const registered = context.getStore(
      MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as boolean | undefined;
    if (registered !== true) {
      throw new Error(
        "MCP plugin required: routes using .from(mcp(...)) require the MCP plugin. Add mcpPlugin() to your config: plugins: [mcpPlugin()].",
      );
    }
    const directAdapter = direct<T>(this.endpoint, this.options);
    return directAdapter.subscribe(context, handler, abortController, onReady);
  }
}
