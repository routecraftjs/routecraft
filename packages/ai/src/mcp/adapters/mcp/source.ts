import {
  rcError,
  routeCanSuspend,
  type Exchange,
  type Source,
  type Subscription,
} from "@routecraft/routecraft";
import {
  MCP_LOCAL_TOOL_REGISTRY,
  MCP_PLUGIN_REGISTERED,
  type McpLocalToolEntry,
  type McpServerOptions,
} from "../../types.ts";
import type { McpMessage } from "./types.ts";
import { BRAND_MCP_ADAPTER } from "./shared.ts";
import {
  deriveAnnotationsFromTags,
  mergeAnnotations,
} from "../../annotation-tags.ts";
import { MCP_TOOL_NAME_PATTERN } from "../../types.ts";

function assertValidMcpToolName(endpoint: string): void {
  if (!MCP_TOOL_NAME_PATTERN.test(endpoint)) {
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
 */
export class McpSourceAdapter implements Source<McpMessage<undefined>> {
  readonly adapterId: string = "routecraft.adapter.mcp";

  private options: McpServerOptions;

  constructor(options: McpServerOptions = {}) {
    (this as unknown as Record<symbol, boolean>)[BRAND_MCP_ADAPTER] = true;
    this.options = options;
  }

  async subscribe(sub: Subscription<McpMessage<undefined>>): Promise<void> {
    const { context, meta } = sub;
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

    const registered = context.getStore(MCP_PLUGIN_REGISTERED);
    if (registered !== true) {
      throw new Error(
        "MCP plugin required: routes using .from(mcp(...)) require the MCP plugin. Add mcpPlugin() to your config: plugins: [mcpPlugin()].",
      );
    }

    let registry = context.getStore(MCP_LOCAL_TOOL_REGISTRY);
    if (!registry) {
      registry = new Map<string, McpLocalToolEntry>();
      context.setStore(MCP_LOCAL_TOOL_REGISTRY, registry);
    }

    if (registry.has(endpoint)) {
      throw rcError("RC5003", undefined, {
        message: `Duplicate MCP tool endpoint "${endpoint}": another .from(mcp(...)) route already registered this endpoint in the same context`,
        suggestion:
          "Each MCP tool endpoint must be unique within a context. Rename one of the mcp() routes to a different route id.",
      });
    }

    // The engine applies input validation before the handler runs, so the
    // MCP adapter just hands the exchange body / headers through. The
    // principal (set by the MCP server when auth is configured) rides
    // through on headers["routecraft.auth.principal"], the single source
    // of truth for identity.
    const entryHandler = async (exchange: Exchange): Promise<Exchange> => {
      return sub.emit({
        message: exchange.body as McpMessage<undefined>,
        headers: exchange.headers,
      });
    };

    const entry: McpLocalToolEntry = {
      endpoint,
      description,
      handler: entryHandler,
    };
    if (discovery?.title !== undefined) entry.title = discovery.title;
    if (discovery?.input !== undefined) entry.input = discovery.input;
    if (discovery?.output !== undefined) entry.output = discovery.output;
    // A route that can park answers execution one with the framework's
    // Suspended acknowledgment instead of its declared output, so the
    // server must advertise the union. Static `.suspend()` sites are
    // definite; a suspend-capable step (an agent) only MAY park, and the
    // over-approximation is the honest direction for a client.
    const definition = context.getRouteById(endpoint)?.definition;
    if (definition && routeCanSuspend(definition)) {
      entry.suspendable = true;
    }

    // Derive the MCP tool annotation hints from the route's tags so the same
    // fact (does this tool mutate state? is it idempotent? does it reach
    // external systems?) is declared once via `.tag()` rather than duplicated
    // as both a tag and an annotation. Explicit `annotations` passed to
    // `mcp()` override the derived values per-key, so callers retain full
    // control when they need it.
    const annotations = mergeAnnotations(
      deriveAnnotationsFromTags(discovery?.tags),
      this.options.annotations,
    );
    if (annotations !== undefined) entry.annotations = annotations;
    if (this.options.icons !== undefined) entry.icons = this.options.icons;

    // Register the cleanup listener before the insert. Any abort from now on
    // (including one dispatched synchronously from inside addEventListener if
    // the signal is already aborted) will run the cleanup, so the entry never
    // outlives its teardown handler.
    sub.signal.addEventListener(
      "abort",
      () => {
        const current = context.getStore(MCP_LOCAL_TOOL_REGISTRY);
        current?.delete(endpoint);
      },
      { once: true },
    );

    if (sub.signal.aborted) {
      return;
    }

    registry.set(endpoint, entry);

    sub.ready();

    await new Promise<void>((resolve) => {
      if (sub.signal.aborted) {
        resolve();
        return;
      }
      sub.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }
}
