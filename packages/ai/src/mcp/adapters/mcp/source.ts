import {
  rcError,
  type CraftContext,
  type Exchange,
  type ExchangeHeaders,
  type Source,
  type SourceMeta,
} from "@routecraft/routecraft";
import {
  MCP_LOCAL_TOOL_REGISTRY,
  MCP_PLUGIN_REGISTERED,
  type McpLocalToolEntry,
  type McpServerOptions,
} from "../../types.ts";
import type { McpMessage } from "./types.ts";
import { BRAND_MCP_ADAPTER } from "./shared.ts";

/**
 * Characters allowed in an MCP tool name. Matches OpenAI's function-calling
 * constraint (the strictest mainstream LLM client), which all major MCP
 * client implementations respect: ASCII letters, digits, underscore, and
 * hyphen, with a 1-64 length bound. Keeping tool names in this set ensures
 * the `tool.name` field survives `tools/list` -> LLM function-calling
 * without further mangling.
 */
const MCP_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function assertValidMcpToolName(endpoint: string): void {
  if (!MCP_TOOL_NAME_RE.test(endpoint)) {
    throw rcError("RC5003", undefined, {
      message: `Invalid MCP tool name "${endpoint}"`,
      suggestion:
        "MCP tool names must match /^[A-Za-z0-9_-]{1,64}$/ for client interoperability (OpenAI, Anthropic, etc.). Use alphanumerics, underscore, or hyphen in the route's .id().",
    });
  }
}

/**
 * McpSourceAdapter exposes a route as an MCP tool.
 *
 * The tool name is the route id (validated against the MCP protocol name
 * regex). The tool's title / description / input / output schemas come
 * from the route's discovery bundle (`.title()` / `.description()` /
 * `.input()` / `.output()`); framework-level input validation is applied
 * before the route handler runs. Adapter options hold only MCP-protocol
 * extras (annotations, icons).
 *
 * Maintains its own registry ({@link MCP_LOCAL_TOOL_REGISTRY}) so MCP and
 * direct routes stay fully isolated: a shared endpoint string does not
 * collide, and direct routes never leak into MCP `tools/list`.
 *
 * @experimental
 */
export class McpSourceAdapter implements Source<McpMessage<undefined>> {
  readonly adapterId: string = "routecraft.adapter.mcp";

  private options: McpServerOptions;

  constructor(options: McpServerOptions = {}) {
    (this as unknown as Record<symbol, boolean>)[BRAND_MCP_ADAPTER] = true;
    this.options = options;
  }

  async subscribe(
    context: CraftContext,
    handler: (
      message: McpMessage<undefined>,
      headers?: ExchangeHeaders,
    ) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
    meta?: SourceMeta,
  ): Promise<void> {
    if (!meta?.routeId) {
      throw rcError("RC5003", undefined, {
        message:
          "McpSourceAdapter requires a route id from the engine (missing SourceMeta.routeId)",
        suggestion:
          "MCP source adapters take their tool name from the route id. Call .id('tool-name') on the route before .from(mcp(...)).",
      });
    }

    const endpoint = meta.routeId;
    assertValidMcpToolName(endpoint);

    const discovery = meta.discovery;
    const description = discovery?.description;
    if (typeof description !== "string" || description.length === 0) {
      throw rcError("RC5003", undefined, {
        message: `MCP route "${endpoint}" requires a description`,
        suggestion:
          "Set .description('...') on the route builder before .from(mcp()); the MCP protocol requires a non-empty description for each tool.",
      });
    }

    const registered = context.getStore(
      MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as boolean | undefined;
    if (registered !== true) {
      throw new Error(
        "MCP plugin required: routes using .from(mcp(...)) require the MCP plugin. Add mcpPlugin() to your config: plugins: [mcpPlugin()].",
      );
    }

    let registry = context.getStore(
      MCP_LOCAL_TOOL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as Map<string, McpLocalToolEntry> | undefined;
    if (!registry) {
      registry = new Map<string, McpLocalToolEntry>();
      context.setStore(
        MCP_LOCAL_TOOL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
        registry,
      );
    }

    if (registry.has(endpoint)) {
      throw rcError("RC5003", undefined, {
        message: `Duplicate MCP tool endpoint "${endpoint}": another .from(mcp(...)) route already registered this endpoint in the same context`,
        suggestion:
          "Each MCP tool endpoint must be unique within a context. Rename one of the mcp() routes to a different route id.",
      });
    }

    // The engine applies input validation before the handler runs, so the
    // MCP adapter just hands the exchange body / headers through.
    const entryHandler = async (exchange: Exchange): Promise<Exchange> => {
      return handler(
        exchange.body as McpMessage<undefined>,
        exchange.headers,
      ) as Promise<Exchange>;
    };

    const entry: McpLocalToolEntry = {
      endpoint,
      description,
      handler: entryHandler,
    };
    if (discovery?.title !== undefined) entry.title = discovery.title;
    if (discovery?.input !== undefined) entry.input = discovery.input;
    if (discovery?.output !== undefined) entry.output = discovery.output;
    if (this.options.annotations !== undefined) {
      entry.annotations = this.options.annotations;
    }
    if (this.options.icons !== undefined) entry.icons = this.options.icons;

    // Register the cleanup listener before the insert. Any abort from now on
    // (including one dispatched synchronously from inside addEventListener if
    // the signal is already aborted) will run the cleanup, so the entry never
    // outlives its teardown handler.
    abortController.signal.addEventListener(
      "abort",
      () => {
        const current = context.getStore(
          MCP_LOCAL_TOOL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry,
        ) as Map<string, McpLocalToolEntry> | undefined;
        current?.delete(endpoint);
      },
      { once: true },
    );

    if (abortController.signal.aborted) {
      return;
    }

    registry.set(endpoint, entry);

    onReady?.();

    await new Promise<void>((resolve) => {
      if (abortController.signal.aborted) {
        resolve();
        return;
      }
      abortController.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }
}
