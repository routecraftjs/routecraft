import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  direct,
  type CraftContext,
  type Exchange,
  type ExchangeHeaders,
  type Source,
} from "@routecraft/routecraft";
import { MCP_PLUGIN_REGISTERED, type McpServerOptions } from "../../types.ts";
import type { McpMessage } from "./types.ts";
import { BRAND_MCP_ADAPTER } from "./shared.ts";

/**
 * McpSourceAdapter implements the Source interface for the MCP adapter.
 *
 * This adapter is used when mcp() is called with two arguments:
 * - `mcp(endpoint, options)` where options contains a description (required for MCP)
 *
 * It delegates to the direct() adapter internally after validating the MCP plugin is registered.
 * The MCP plugin will expose these routes as tools via the MCP protocol.
 */
export class McpSourceAdapter<
  S extends StandardSchemaV1 | undefined = undefined,
> implements Source<McpMessage<S>> {
  readonly adapterId: string = "routecraft.adapter.mcp";

  private endpoint: string;
  private options: McpServerOptions & { schema?: S };

  constructor(endpoint: string, options: McpServerOptions & { schema?: S }) {
    (this as unknown as Record<symbol, boolean>)[BRAND_MCP_ADAPTER] = true;
    this.endpoint = endpoint;
    this.options = options;
  }

  async subscribe(
    context: CraftContext,
    handler: (
      message: McpMessage<S>,
      headers?: ExchangeHeaders,
    ) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    // Verify MCP plugin is registered
    const registered = context.getStore(
      MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as boolean | undefined;
    if (registered !== true) {
      throw new Error(
        "MCP plugin required: routes using .from(mcp(...)) require the MCP plugin. Add mcpPlugin() to your config: plugins: [mcpPlugin()].",
      );
    }

    // Delegate to direct adapter
    const directAdapter = direct(this.endpoint, this.options);
    return directAdapter.subscribe(context, handler, abortController, onReady);
  }
}
