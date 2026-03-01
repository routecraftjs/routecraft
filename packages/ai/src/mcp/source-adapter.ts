import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  direct,
  type CraftContext,
  type Exchange,
  type ExchangeHeaders,
  type Source,
} from "@routecraft/routecraft";
import type { McpServerOptions } from "./types.ts";
import { MCP_PLUGIN_REGISTERED } from "./types.ts";

/** Message type derived from schema S when present; otherwise unknown. */
type McpServerMessage<S extends StandardSchemaV1 | undefined> =
  S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : unknown;

/**
 * Internal server: .from(mcp(endpoint, options)). Delegates to direct(); requires MCP plugin.
 * Exported only for use by McpAdapter; not re-exported from package.
 * Generic S is the options schema type; T is derived so the handler matches direct() without cast.
 */
export class McpServer<
  S extends StandardSchemaV1 | undefined = undefined,
> implements Source<McpServerMessage<S>> {
  readonly adapterId = "routecraft.adapter.mcp.source";

  constructor(
    private readonly endpoint: string,
    private readonly options: McpServerOptions & { schema?: S },
  ) {}

  async subscribe(
    context: CraftContext,
    handler: (
      message: McpServerMessage<S>,
      headers?: ExchangeHeaders,
    ) => Promise<Exchange>,
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
    const directAdapter = direct(this.endpoint, this.options);
    return directAdapter.subscribe(context, handler, abortController, onReady);
  }
}
