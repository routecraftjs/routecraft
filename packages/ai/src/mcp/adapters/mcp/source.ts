import {
  rcError,
  routeCanDefer,
  type CraftContext,
  type Exchange,
  type Source,
  type Subscription,
} from "@routecraft/routecraft";
import { MCP, type McpService } from "../../port.ts";
import type {
  McpLocalToolEntry,
  McpProxyRegistration,
  McpServerOptions,
  McpToolRequest,
  McpUiOptions,
} from "../../types.ts";
import { parseProxyRef, type McpProxyRef } from "../../proxy.ts";
import type { McpMessage } from "./types.ts";
import { BRAND_MCP_ADAPTER } from "./shared.ts";
import {
  deriveAnnotationsFromTags,
  mergeAnnotations,
} from "../../annotation-tags.ts";
import { MCP_TOOL_NAME_PATTERN } from "../../types.ts";

/** What the engine discovered on the route builder, as the subscription carries it. */
type RouteDiscovery = NonNullable<
  Subscription<McpMessage<undefined>>["meta"]
>["discovery"];

/** The MCP service, or the one fault for a route whose context lacks the plugin. */
function requireMcpService(context: CraftContext, form: string): McpService {
  const service = context.lookup(MCP);
  if (!service) {
    throw rcError("RC5003", undefined, {
      message: `MCP plugin required: routes using .from(${form}) require the MCP plugin. Add \`mcp: {}\` to defineConfig({...}) in craft.config.ts, or mcpPlugin() to the plugins of a context you build yourself.`,
    });
  }
  return service;
}

function assertValidMcpToolName(endpoint: string): void {
  if (!MCP_TOOL_NAME_PATTERN.test(endpoint)) {
    throw rcError("RC5003", undefined, {
      message: `Invalid MCP tool name "${endpoint}"`,
      suggestion:
        "MCP tool names must match /^[A-Za-z0-9_-]{1,64}$/ for client interoperability (OpenAI, Anthropic, etc.). Use alphanumerics, underscore, or hyphen in the route's .id().",
    });
  }
}

const UI_CSP_KEYS = [
  "connectDomains",
  "resourceDomains",
  "frameDomains",
  "baseUriDomains",
] as const;

/** Reject a malformed `ui` option when `mcp()` is called, not when a host first reads the view. */
function assertValidUiOptions(ui: McpUiOptions): void {
  const invalid = (message: string): never => {
    throw rcError("RC5003", undefined, {
      message: `mcp(): ${message}`,
      suggestion:
        "Pass ui: { html, csp?, prefersBorder? } where html is an HTML string or a function returning one, for example fromFile('./view.html').",
    });
  };
  if (typeof ui !== "object" || ui === null) invalid("ui must be an object");
  const { html, csp, prefersBorder } = ui;
  if (typeof html === "string") {
    if (html.trim().length === 0) invalid("ui.html must not be empty");
  } else if (typeof html !== "function") {
    invalid("ui.html must be a string or a function returning one");
  }
  if (csp !== undefined) {
    if (typeof csp !== "object" || csp === null)
      invalid("ui.csp must be an object");
    for (const key of UI_CSP_KEYS) {
      const origins = csp[key];
      if (
        origins !== undefined &&
        (!Array.isArray(origins) ||
          origins.some((o) => typeof o !== "string" || o.trim() === ""))
      ) {
        invalid(`ui.csp.${key} must be an array of non-empty origin strings`);
      }
    }
  }
  if (prefersBorder !== undefined && typeof prefersBorder !== "boolean") {
    invalid("ui.prefersBorder must be a boolean");
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
 * extras (annotations, icons, an MCP Apps view).
 *
 * Registers in the MCP service's own `local` registry so MCP and
 * direct routes stay fully isolated: a shared endpoint string does not
 * collide, and direct routes never leak into MCP `tools/list`.
 */
export class McpSourceAdapter implements Source<McpMessage<undefined>> {
  readonly adapterId: string = "routecraft.adapter.mcp";

  private options: McpServerOptions;

  /**
   * The client and tool this source proxies, when it is the proxy form.
   * Read by the agent tool resolver off the route definition, live or not,
   * so a tool whose proxy route is held back is withheld rather than raw.
   */
  readonly proxyRef: McpProxyRef | undefined;

  constructor(options: McpServerOptions = {}) {
    (this as unknown as Record<symbol, boolean>)[BRAND_MCP_ADAPTER] = true;
    if (options.ui !== undefined) assertValidUiOptions(options.ui);
    this.proxyRef = assertValidProxyOptions(options);
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
    if (this.proxyRef !== undefined) {
      return this.subscribeProxy(sub, this.proxyRef, endpoint, meta.discovery);
    }
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

    if (
      this.options.ui !== undefined &&
      discovery?.output?.body === undefined
    ) {
      throw rcError("RC5003", undefined, {
        message: `MCP route "${endpoint}" has a ui view but declares no output`,
        suggestion:
          "A view draws from the tool's structured result. Declare .output({ body: schema }) on the route before .from(mcp({ ui })).",
      });
    }

    const service = requireMcpService(context, "mcp(...)");
    if (service.local.has(endpoint)) {
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
    const entryHandler = async (request: McpToolRequest): Promise<Exchange> => {
      return sub.emit({
        message: request.body as McpMessage<undefined>,
        headers: request.headers,
      });
    };

    const entry: McpLocalToolEntry = {
      endpoint,
      description,
      handler: entryHandler,
      ...this.routeToolMetadata(context, endpoint, discovery),
    };
    if (discovery?.input !== undefined) entry.input = discovery.input;
    if (discovery?.output !== undefined) entry.output = discovery.output;
    if (this.options.ui !== undefined) entry.ui = this.options.ui;

    await this.holdUntilAborted(sub, () => service.registerLocal(entry));
  }

  /**
   * The tool metadata the route's builder declares, the same for a route
   * that is its own tool and for one proxying a client: the title; the
   * annotation hints derived from the route's tags, so a fact such as "this
   * tool mutates state" is declared once with `.tag()`, with explicit
   * `annotations` on `mcp()` overriding per key; the icons; and whether the
   * route can defer, in which case execution one may answer with the
   * framework's `Deferred` acknowledgment instead of the declared output and
   * the server must advertise the union. A static `.defer()` site is
   * definite and a defer-capable step (an agent) only may defer; the
   * over-approximation is the honest direction for a client. The context
   * decides it because a registered error handler that may park can defer
   * any route, including one declaring no defer site of its own; without it
   * every such route is under-advertised, and a client validating results
   * against the declared output rejects the acknowledgment the route
   * legitimately answered with.
   */
  private routeToolMetadata(
    context: CraftContext,
    routeId: string,
    discovery: RouteDiscovery,
  ): Pick<McpLocalToolEntry, "title" | "annotations" | "icons" | "deferrable"> {
    const metadata: Pick<
      McpLocalToolEntry,
      "title" | "annotations" | "icons" | "deferrable"
    > = {};
    if (discovery?.title !== undefined) metadata.title = discovery.title;
    const annotations = mergeAnnotations(
      deriveAnnotationsFromTags(discovery?.tags),
      this.options.annotations,
    );
    if (annotations !== undefined) metadata.annotations = annotations;
    if (this.options.icons !== undefined) metadata.icons = this.options.icons;
    const definition = context.getRouteById(routeId)?.definition;
    if (definition && routeCanDefer(definition, context)) {
      metadata.deferrable = true;
    }
    return metadata;
  }

  /**
   * Register through `register`, withdraw on abort, signal readiness, and
   * hold the subscription open until it is aborted. The withdrawal is
   * attached before anything else happens, so an abort from then on
   * (including one dispatched synchronously from inside `addEventListener`
   * when the signal is already aborted) runs it and the registration never
   * outlives its teardown.
   */
  private async holdUntilAborted(
    sub: Subscription<McpMessage<undefined>>,
    register: () => () => void,
  ): Promise<void> {
    if (sub.signal.aborted) return;
    sub.signal.addEventListener("abort", register(), { once: true });
    sub.ready();
    await new Promise<void>((resolve) => {
      if (sub.signal.aborted) {
        resolve();
        return;
      }
      sub.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  /**
   * The proxy half of the source, split out of `subscribe` so the two paths
   * read on their own: a route that is its own tool registers one local
   * entry; a route that proxies a client registers once and the server
   * turns it into one tool per remote tool the client lists.
   */
  private async subscribeProxy(
    sub: Subscription<McpMessage<undefined>>,
    ref: McpProxyRef,
    routeId: string,
    discovery: RouteDiscovery,
  ): Promise<void> {
    const { context } = sub;
    const service = requireMcpService(context, "mcp({ proxy })");
    if (!service.clients.has(ref.serverId)) {
      const known = [...service.clients.keys()];
      throw rcError("RC5003", undefined, {
        message: `Route "${routeId}" proxies client "${ref.serverId}", which is not registered`,
        suggestion:
          known.length > 0
            ? `Register it under mcpPlugin({ clients }). Registered clients: ${known.map((k) => `"${k}"`).join(", ")}.`
            : "Register it under mcpPlugin({ clients }); no clients are registered in this context.",
      });
    }

    const registration: McpProxyRegistration = {
      serverId: ref.serverId,
      tool: ref.tool,
      prefix: this.options.prefix ?? `${ref.serverId}_`,
      routeId,
      handler: (request: McpToolRequest) =>
        sub.emit({
          message: request.body as McpMessage<undefined>,
          headers: request.headers,
        }),
      ...this.routeToolMetadata(context, routeId, discovery),
    };
    if (this.options.name !== undefined) registration.name = this.options.name;
    if (ref.exclude !== undefined) registration.exclude = ref.exclude;
    if (discovery?.description !== undefined) {
      if (discovery.description.length === 0) {
        throw rcError("RC5003", undefined, {
          message: `MCP route "${routeId}" declares an empty description`,
          suggestion:
            "Leave .description() off to pass the remote's description through, or give one with text; the MCP protocol requires a non-empty description for each tool.",
        });
      }
      registration.description = discovery.description;
    }

    await this.holdUntilAborted(sub, () => service.registerProxy(registration));
  }
}

/**
 * Validate the `proxy`, `prefix` and `name` options when `mcp()` is called,
 * not when the route starts, and parse the ref once.
 */
function assertValidProxyOptions(
  options: McpServerOptions,
): McpProxyRef | undefined {
  const invalid = (message: string, suggestion: string): never => {
    throw rcError("RC5003", undefined, {
      message: `mcp(): ${message}`,
      suggestion,
    });
  };
  if (options.proxy === undefined) {
    if (
      options.prefix !== undefined ||
      options.name !== undefined ||
      options.exclude !== undefined
    ) {
      invalid(
        "prefix, name and exclude apply to a proxy source only",
        'Pass proxy: "server:*" or "server:tool" beside them, or drop them: a route that is its own tool is named by its .id().',
      );
    }
    return undefined;
  }
  let ref: McpProxyRef;
  try {
    ref = parseProxyRef(options.proxy);
  } catch (error) {
    return invalid(
      error instanceof Error ? error.message : String(error),
      'Use proxy: "server:*" for every tool of a registered client, or proxy: "server:tool" for one of them.',
    );
  }
  if (options.ui !== undefined) {
    invalid(
      "a proxy source cannot carry a ui view",
      "A view is served for a tool this route defines; a proxied tool is defined by the remote. Drop ui, or wrap the one tool in its own .from(mcp()) route.",
    );
  }
  if (options.prefix !== undefined && typeof options.prefix !== "string") {
    invalid("prefix must be a string", 'Use prefix: "" for bare remote names.');
  }
  if (options.exclude !== undefined) {
    if (ref.tool !== "*") {
      invalid(
        `exclude cannot be set with the exact proxy "${options.proxy}"`,
        "exclude leaves tools out of a star proxy; an exact proxy names the one tool it serves.",
      );
    }
    if (
      !Array.isArray(options.exclude) ||
      options.exclude.length === 0 ||
      options.exclude.some(
        (tool) => typeof tool !== "string" || !MCP_TOOL_NAME_PATTERN.test(tool),
      )
    ) {
      invalid(
        "exclude must be a non-empty array of remote tool names",
        'Name the tools as the remote lists them, for example exclude: ["create_issue"].',
      );
    }
    ref = { ...ref, exclude: [...options.exclude] };
  }
  if (options.name !== undefined) {
    if (ref.tool === "*") {
      invalid(
        `name cannot be set with the star proxy "${options.proxy}"`,
        "A name renames one tool. Name the tool in the proxy ref, or set prefix for the whole client.",
      );
    }
    if (
      typeof options.name !== "string" ||
      !MCP_TOOL_NAME_PATTERN.test(options.name)
    ) {
      invalid(
        `name "${String(options.name)}" is not a valid MCP tool name`,
        "MCP tool names must match /^[A-Za-z0-9_-]{1,64}$/.",
      );
    }
  }
  return ref;
}
