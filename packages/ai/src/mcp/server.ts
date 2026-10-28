import type {
  PortLookup,
  EventDetailsMap,
  EventHandler,
  EventName,
  ExchangeHeaders,
  PluginLogger,
} from "@routecraft/routecraft";
import {
  adoptTraceContext,
  type AdoptedTraceHeaders,
  buildProtectedResourceMetadata,
  callerRefusalOf,
  HeadersKeys,
  isRoutecraftError,
  isDeferred,
  isDevelopmentRuntime,
  type Authority,
  rcError,
  requireWebIngress,
  type CallerRefusalOrigin,
  type ProtectedResourceMetadata,
} from "@routecraft/routecraft";
import type { PathClaim, WebIngress } from "@routecraft/routecraft";
import type {
  AuthInfo,
  CallToolResult,
  ListToolsResult,
  McpHttpHandler,
  ReadResourceResult,
  ResourceNotFoundError,
  Server as SdkServer,
} from "@modelcontextprotocol/server";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type {
  HttpMountAuth,
  HttpMountContext,
  Principal,
  ValidatorAuthOptions,
} from "@routecraft/routecraft";
import { McpHeadersKeys } from "./types.ts";
import type { McpToolMount, McpToolProvenance } from "../errors.ts";
import type { McpService } from "./port.ts";
import type {
  McpIcon,
  McpLocalToolEntry,
  McpPluginOptions,
  McpTool,
} from "./types.ts";
import { refuseBearer } from "../mount/bearer.ts";
import { normalizeMcpPath } from "./validate-options.ts";
import {
  resolveClientEntries,
  resolveProxiedEntries,
  type McpClientEntry,
  type McpProxiedEntry,
} from "./proxy.ts";
import {
  buildCorsHeaders,
  PROTECTED_RESOURCE_METADATA_PATH,
  resolveCorsOptions,
} from "./cors.ts";
import { ROUTECRAFT_DEFAULT_ICONS } from "./default-icon.ts";
import { toolFailureText } from "./tool-failure.ts";
import { takeUnalteredHopResult } from "./dispatch.ts";
import {
  loadUiHtml,
  MCP_APP_MIME_TYPE,
  uiReadResult,
  uiResourceUri,
} from "./ui-resource.ts";
import { buildEnrichedVerifier } from "./userinfo.ts";
import { loadMcpServerSdk, loadMcpServerStdioSdk } from "./sdk.ts";
import {
  advertisedOutputArms,
  declinedError,
  enforceAdvertisedOutput,
} from "./tool-result-guards.ts";

/**
 * MCP SDK `AuthInfo` shape. Imported as a type so nothing is required at
 * runtime from the SDK just for this alias; `import type` is erased by the
 * compiler.
 */
type SdkAuthInfo = AuthInfo;

/** How to run the HTTP transport over plain http locally, shared by the resource guards. */
const LOCAL_HTTP_HINT =
  "For local work over plain http, run with NODE_ENV=development; an unset NODE_ENV counts as production.";

/** True for a plain, non-array, non-null object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize `tools/call` arguments to a plain object. The MCP SDK may deliver
 * a parsed object or a raw JSON string; MCP tool arguments are always a JSON
 * object, so a primitive, array, or null is coerced to the safe fallback
 * shape (`{ input: <string> }` for a raw non-object string, `{}` otherwise)
 * before any guard or remote dispatch consumes it.
 */
function normalizeToolArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      return isPlainObject(parsed) ? parsed : { input: args };
    } catch {
      return { input: args };
    }
  }
  return isPlainObject(args) ? args : {};
}

/**
 * Wire shape returned by `tools/call` handlers (local and proxied), before
 * the era projection in {@link McpServer.createServerInstance} runs.
 *
 * `structuredContent` is any JSON value here, not an object: a route
 * declaring `.output({ body: z.string() })` publishes its string, and the
 * SDK's `projectCallToolResult` is what decides whether the negotiated era
 * needs it wrapped as `{ result: <value> }`.
 *
 * `advertisedOutputSchema` is what that decision is made from, and it travels
 * with the value rather than being looked up again at the seam. The two are
 * one fact: the value is wrapped exactly when the advertisement it was
 * produced under is wrapped. Resolving the tool a second time by name would
 * re-read a live registry that an unsubscribe can empty while a route is
 * still deferred, and answer with an unwrapped body under a wrapped promise.
 */
type McpToolCallResult = {
  content: Array<{ type: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  advertisedOutputSchema?: Record<string, unknown>;
};

/**
 * Log-safe message for a failed tool call: the RC meta message for
 * RoutecraftErrors, the error message otherwise.
 */
function toolErrorLogMessage(error: unknown): string {
  return isRoutecraftError(error)
    ? error.meta.message
    : error instanceof Error
      ? error.message
      : String(error);
}

/** The wire result for a tool call that did not answer, a decline or a failure. */
function toolErrorResult(text: string): McpToolCallResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

/** Resolved options with defaults applied (internal use). */
type McpServerResolvedOptions = Required<
  Pick<McpPluginOptions, "name" | "version" | "transport" | "server" | "path">
> &
  Pick<
    McpPluginOptions,
    | "tools"
    | "auth"
    | "title"
    | "resource"
    | "cors"
    | "browserOrigins"
    | "userinfo"
    | "description"
    | "websiteUrl"
    | "instructions"
    | "icons"
    | "traceContext"
  >;

/**
 * An icon in the mutable shape the SDK's generated schema expects. Routecraft's
 * own icons freeze `sizes` so the shared default cannot be corrupted in place,
 * and the SDK's schema does not model that, so the two shapes differ by exactly
 * this field.
 */
type SdkIcon = Omit<McpIcon, "sizes"> & { sizes?: string[] };

/** The MCP SDK `Server` constructor info arg (the fields we populate). */
type SdkServerInfo = {
  name: string;
  version: string;
  title?: string;
  description?: string;
  websiteUrl?: string;
  icons?: SdkIcon[];
};

/** The MCP SDK `Server` constructor options arg (the fields we populate). */
type SdkServerOptions = {
  capabilities: {
    tools: Record<string, unknown>;
    resources: Record<string, unknown>;
  };
  instructions?: string;
};

/**
 * What the MCP server needs from the application: the MCP plugin's own
 * context for logging and events, and the service it serves and proxies.
 */
export interface McpServerHost {
  readonly logger: PluginLogger;
  emit<K extends EventName>(event: K, details: EventDetailsMap[K]): void;
  observe<K extends EventName>(event: K, handler: EventHandler<K>): () => void;
  /** The tools this application serves, and the clients it proxies. */
  readonly service: McpService;
  /**
   * Where the HTTP mount looks up the `WEB_INGRESS` port for its named
   * server: the plugin context, which declares the port optional.
   */
  readonly ingress: PortLookup;
  /** Brands the identities the server verifies, for the gates to trust. */
  readonly authority: Authority;
}

/**
 * One path the server answers at, and the slice of tools it lists there.
 * The root lists everything under the prefixed names; a client mount,
 * whose segment is the client id, lists that client's proxied tools under
 * their remote names; the own mount, named after the server, lists the
 * application's own tools, every local route and every exact proxy route,
 * under their exposed names.
 *
 * @internal
 */
export type McpMount =
  | { readonly kind: "root"; readonly segment: "" }
  | { readonly kind: "client"; readonly segment: string }
  | { readonly kind: "own"; readonly segment: string };

const ROOT_MOUNT: McpMount = { kind: "root", segment: "" };

/**
 * What may name a mount, since it becomes one path segment: the dot
 * segments are excluded because a URL parser folds them away, so the
 * mount could never be addressed and its resource URL would name the parent.
 */
const MOUNT_SEGMENT_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

/** Where a tool call arrived, as its events carry it: nothing for the root. */
type McpToolStamp = McpToolProvenance & McpToolMount;

/** What a mount serves under one name: the entry, and the hop for a proxied tool. */
type McpServedTool = { entry: McpLocalToolEntry; proxied?: McpProxiedEntry };

/**
 * McpServer wraps the MCP SDK and bridges it to Routecraft's DirectChannel
 * infrastructure. It reads the MCP route registry lazily (on first `tools/list`
 * request) to ensure routes have subscribed.
 *
 * Serving follows protocol revision 2026-07-28: both transports build a fresh
 * server instance per serving unit and hold no state between them, so the HTTP
 * transport scales horizontally with no session affinity. 2025-era clients are
 * still served, through the SDK's stateless fallback.
 *
 * The SDK is loaded through `loadOptionalPeer` (see `./sdk.ts`) because it is
 * an optional peer dependency, not because of any type incompatibility.
 */
export class McpServer {
  private readonly host: McpServerHost;
  private readonly service: McpService;
  private context: PortLookup;
  private options: McpServerResolvedOptions;
  /** One SDK handler per mount: a handler owns the sessions it opens, and a session lists its mount's slice. */
  private readonly mcpHandlers = new Map<string, McpHttpHandler>();
  private unmountHttp: (() => void) | null = null;
  /** Handle for the stdio transport, used to await shutdown. `null` on HTTP. */
  private stdioHandle: StdioServerHandle | null = null;
  /**
   * Per-request factory inputs, resolved once by {@link prepareServerFactory}
   * so {@link createServerInstance} stays off the dynamic-import path.
   */
  private sdkServerCtor: typeof SdkServer | null = null;
  private resourceNotFound: typeof ResourceNotFoundError | null = null;
  private serverInfo: SdkServerInfo | null = null;
  private serverOptions: SdkServerOptions | null = null;
  private running = false;
  /**
   * The HTTP mount has a validator, so a call without a principal could
   * have carried one. Decides whether a route's missing-principal refusal
   * is the caller's to fix; stdio carries no credentials and leaves it off.
   */
  private acceptsCredentials = false;
  private boundPort: number | undefined;
  private readonly stopListeningForServer: () => void;
  private toolsListLogged = false;
  /**
   * Deduplication keys for proxy-resolution warnings, scoped to a
   * resolution epoch: each distinct condition (an unusable exposed name, a
   * collision) logs once per epoch instead of per request, and re-logs if
   * it recurs after the clients' tool lists or the registrations actually
   * changed (a client that recovers and then degrades again is not silenced
   * by its first outage).
   */
  private proxyWarnings = new Set<string>();

  /**
   * The registry and registration versions the memoized proxy resolution
   * was computed against, as one key.
   */
  private proxyResolvedVersion = "";

  /** Memoized proxy resolution; recomputed only when either version moved. */
  private proxyResolved: Map<string, McpProxiedEntry> = new Map();

  /**
   * The stdio connections' server instances, told when the advertised tool
   * set changes. HTTP instances are per request and have no connection to
   * tell; an HTTP client learns of a change by listing again.
   */
  private readonly stdioServers = new Set<SdkServer>();

  /** The exposed tool names last advertised, to tell a change from a refresh. */
  private advertisedNames: string | undefined;

  /** The client mounts' entries, by client, cleared with the proxy resolution. */
  private readonly clientResolved = new Map<
    string,
    Map<string, McpClientEntry>
  >();

  /** Unsubscribes from the client listing events `start` observed. */
  private readonly stopObservingClients: Array<() => void> = [];

  /**
   * Memoized `tools/list` output schema per registry entry, keyed by the
   * entry object the registry hands out.
   *
   * `tools/list` converts every exposed entry and `tools/call` consults the
   * result once per request, so the Standard Schema conversion sits on both
   * hot paths. Registry entries are created once per subscription and handed
   * out by reference, so a key never goes stale and the map is bounded by the
   * number of registered routes.
   */
  private readonly outputSchemaJson = new WeakMap<
    McpLocalToolEntry,
    Record<string, unknown> | undefined
  >();
  /**
   * Validator-mode token verifier, optionally wrapped with `userinfo`
   * enrichment. Built eagerly during mount preparation so a misconfigured
   * `userinfo: true` (no issuer) fails at startup rather than on first
   * request. `null` until the HTTP transport starts.
   */

  constructor(host: McpServerHost, options: McpPluginOptions = {}) {
    this.host = host;
    this.service = host.service;
    this.context = host.ingress;
    this.options = {
      version: "1.0.0",
      transport: "stdio",
      server: "default",
      path: "/mcp",
      ...options,
      name: options.name ?? "routecraft",
    };
    this.validateResourceConfig();
    this.stopListeningForServer = host.observe(
      "server:listening",
      ({ details }) => {
        if (details.server !== this.options.server) return;
        this.boundPort = details.port;
      },
    );
  }

  /** Bound port for the named server after `server:listening` fires. */
  getHttpPort(): number | undefined {
    return this.boundPort;
  }

  /**
   * Resolve the server-level icons: the Routecraft default when unset, the
   * consumer's icons otherwise (an explicit empty array means "no icon").
   */
  private resolveServerIcons(): McpIcon[] {
    return this.options.icons === undefined
      ? ROUTECRAFT_DEFAULT_ICONS
      : this.options.icons;
  }

  /**
   * Apply a default when the value is unset, then treat an empty string as an
   * explicit opt-out (returns `undefined` so the caller omits the field). This
   * is the uniform "default unless empty" contract used by every optional
   * string field of the server identity.
   */
  private defaultUnlessEmpty(
    value: string | undefined,
    fallback: string,
  ): string | undefined {
    const resolved = value ?? fallback;
    return resolved === "" ? undefined : resolved;
  }

  /**
   * Build the MCP `serverInfo` (`Implementation`) object shared by both
   * transports. Applies the Routecraft "powered by" defaults for description,
   * websiteUrl, and icons; an empty string/array opts out of a given field.
   */
  private buildServerInfo(): SdkServerInfo {
    const info: SdkServerInfo = {
      name: this.options.name,
      version: this.options.version,
    };
    if (this.options.title !== undefined) {
      info.title = this.options.title;
    }

    const description = this.defaultUnlessEmpty(
      this.options.description,
      "Powered by Routecraft.dev",
    );
    if (description !== undefined) {
      info.description = description;
    }

    const websiteUrl = this.defaultUnlessEmpty(
      this.options.websiteUrl,
      "https://routecraft.dev",
    );
    if (websiteUrl !== undefined) {
      info.websiteUrl = websiteUrl;
    }

    const icons = this.resolveServerIcons();
    if (icons.length > 0) {
      // Copying is the ownership handover: what the SDK holds is its own, so a
      // mutation on its side cannot reach the frozen default every other
      // server and tool in this process is sharing.
      info.icons = icons.map(({ sizes, ...rest }) => ({
        ...rest,
        ...(sizes ? { sizes: [...sizes] } : {}),
      }));
    }
    return info;
  }

  /**
   * Build the MCP `Server` options arg (capabilities plus optional
   * instructions). `instructions` has no default; an empty string opts out,
   * matching the empty-value contract of the serverInfo string fields.
   *
   * `resources` is declared whether or not any route has a view: capabilities
   * are fixed when a stdio connection opens, which can precede the routes
   * subscribing, and an empty `resources/list` costs a client nothing.
   */
  private buildServerOptions(): SdkServerOptions {
    // Only the stdio transport holds a connection to notify; a client may
    // ignore `tools/list_changed` from a server that did not declare it.
    const options: SdkServerOptions = {
      capabilities: {
        tools: this.options.transport === "http" ? {} : { listChanged: true },
        resources: {},
      },
    };
    const instructions = this.defaultUnlessEmpty(this.options.instructions, "");
    if (instructions !== undefined) {
      options.instructions = instructions;
    }
    return options;
  }

  /**
   * Validate plugin-level resource config at construction time. Runs the
   * HTTPS-in-production guard for the shared HTTP transport. A shared
   * listener is commonly published through a TLS-terminating proxy, whose
   * external origin cannot be inferred safely from the local bind address.
   */
  private validateResourceConfig(): void {
    // Resource metadata is served over HTTP only; stdio ignores the option.
    if (this.options.transport !== "http") return;
    const explicit = this.options.resource?.url;
    const relaxed = isDevelopmentRuntime();
    if (explicit === undefined && !relaxed) {
      throw rcError("RC5003", undefined, {
        message:
          "mcpPlugin: resource.url is required for HTTP transport outside development or test",
        suggestion: `Set mcpPlugin({ resource: { url } }) to the HTTPS URL clients reach this server at, for example https://mcp.example.com/mcp. ${LOCAL_HTTP_HINT}`,
      });
    }
    if (explicit === undefined) return;
    let parsed: URL;
    try {
      parsed = new URL(explicit.toString());
    } catch {
      throw rcError("RC5003", undefined, {
        message: `mcpPlugin: resource.url is not an absolute URL: ${explicit.toString()}`,
        suggestion:
          "Set resource.url to the full URL clients reach this server at, scheme included, for example https://mcp.example.com/mcp.",
      });
    }
    if (parsed.protocol !== "https:" && !relaxed) {
      throw rcError("RC5003", undefined, {
        message:
          "mcpPlugin: resource.url must use HTTPS outside development or test",
        suggestion: `Set resource.url to the HTTPS URL your TLS-terminating proxy publishes. ${LOCAL_HTTP_HINT}`,
      });
    }
  }

  /**
   * Start the MCP server and listen for connections
   */
  async start(): Promise<void> {
    if (this.running) {
      this.host.logger.warn({}, "MCP server already running");
      return;
    }

    try {
      const transport = this.options.transport;

      if (transport !== "http") {
        await this.startStdio();
        this.observeClientListings();
      }
      // The HTTP transport does not wait for the named server to bind: a
      // request cannot reach the mount before the listener is up, so every
      // bound-address consumer runs strictly after `server:listening`, and
      // waiting here would deadlock the sequential plugin start hooks
      // whenever this plugin is registered before the servers plugin. A
      // missing or undeclared server already fails fast in prepare() via
      // requireWebIngress.

      this.running = true;
      this.host.logger.info(
        {
          name: this.options.name,
          version: this.options.version,
          transport,
        },
        "MCP server started",
      );
      this.logExposedToolsOnce();
    } catch (error) {
      const msg = isRoutecraftError(error)
        ? error.meta.message
        : error instanceof Error
          ? error.message
          : "Failed to start MCP server";
      this.host.logger.error({ err: error }, msg);
      throw error;
    }
  }

  /** Prepare build-time resources and register the HTTP mount before listeners bind. */
  async prepare(): Promise<void> {
    if (this.options.transport !== "http") return;
    await this.prepareHttpMount();
  }

  private async prepareHttpMount(): Promise<void> {
    const verifier = this.buildValidatorVerifier();
    await this.prepareServerFactory();
    const { createMcpHandler } = await loadMcpServerSdk("mcp (http)");
    const cors = resolveCorsOptions(this.options.cors);
    // Shared contract with mcpPlugin() option validation: McpServer is also
    // constructed directly, and an unvalidated path would mount claims the
    // dispatcher can never match.
    const path = normalizeMcpPath(this.options.path);
    const ingress = requireWebIngress(this.context, this.options.server);
    const mountAuth =
      this.options.auth === undefined ||
      this.options.auth === false ||
      verifier === null
        ? this.options.auth
        : { ...this.options.auth, validator: verifier };
    this.acceptsCredentials = ingress.resolveMountAuth(mountAuth).configured;
    this.validateMounts();
    const served = this.mounts().map((mount) => {
      const mountPath = this.mountPath(path, mount);
      return {
        mount,
        path: mountPath,
        metadataPath: `${PROTECTED_RESOURCE_METADATA_PATH}${mountPath}`,
      };
    });
    for (const { mount } of served) {
      this.mcpHandlers.set(
        mount.segment,
        createMcpHandler(
          (requestContext) =>
            this.createServerInstance(
              this.authInfoToPrincipal(requestContext.authInfo),
              mount,
            ),
          {
            onerror: (error: Error) => {
              this.host.logger.error({ err: error }, "MCP handler error");
            },
          },
        ),
      );
    }
    const claims: PathClaim[] = served.flatMap(
      ({ path: mountPath, metadataPath }): PathClaim[] => [
        {
          kind: "exact",
          path: mountPath,
          methods: ["GET", "POST", "DELETE", "OPTIONS"],
        },
        {
          kind: "exact",
          path: `${mountPath}/`,
          methods: ["GET", "POST", "DELETE", "OPTIONS"],
        },
        { kind: "exact", path: metadataPath, methods: ["GET", "OPTIONS"] },
      ],
    );
    this.unmountHttp = ingress.mountHttp({
      id: "mcp",
      requestValidation: {
        ...(this.options.resource?.url !== undefined
          ? { allowedHostnames: [new URL(this.options.resource.url).hostname] }
          : {}),
        ...(this.options.browserOrigins !== undefined
          ? { browserOrigins: this.options.browserOrigins }
          : {}),
      },
      // Streamable HTTP holds the GET channel open and legitimately quiet;
      // without the exemption Bun's idle reaper would cut it at 255s.
      longLived: true,
      ...(mountAuth !== undefined ? { auth: mountAuth } : {}),
      claims: () => claims,
      handler: async (request, mountContext) => {
        const pathname = new URL(request.url).pathname;
        const origin = request.headers.get("origin") ?? undefined;
        const corsHeaders = buildCorsHeaders(cors, origin, false);

        // Host and explicit browser admission are enforced by the shared
        // ingress. CORS refusal remains an additional, independent policy.
        if (
          origin !== undefined &&
          cors !== null &&
          corsHeaders["Access-Control-Allow-Origin"] === undefined
        ) {
          return Response.json(
            { error: "Forbidden" },
            { status: 403, headers: corsHeaders },
          );
        }

        const endpoint = served.find(
          (candidate) =>
            pathname === candidate.path || pathname === `${candidate.path}/`,
        );
        const discovery = served.find(
          (candidate) => pathname === candidate.metadataPath,
        );
        const owned = endpoint !== undefined || discovery !== undefined;
        if (request.method === "OPTIONS" && cors !== null && owned) {
          return new Response(null, {
            status: 204,
            headers: buildCorsHeaders(cors, origin, true),
          });
        }

        // RFC 9728 discovery is a public protocol exemption: served before
        // any credential handling so a client with a stale or malformed
        // token can still learn where to re-authenticate. Never call
        // `authenticate()` on this path.
        if (discovery !== undefined) {
          return this.serveMetadataDocument(
            ingress,
            discovery.mount,
            mountContext.authPolicy?.issuer,
            corsHeaders,
          );
        }
        if (endpoint === undefined) {
          return Response.json(
            { error: "Not Found", path: pathname },
            { status: 404, headers: corsHeaders },
          );
        }

        const auth = await mountContext.authenticate();
        const refusal = this.refuseAuth(
          auth,
          mountContext.auth,
          ingress,
          endpoint.mount,
          corsHeaders,
        );
        if (refusal) return refusal;

        const principal = auth?.kind === "admit" ? auth.principal : undefined;
        const token = auth?.kind === "admit" ? auth.credential : undefined;
        const response = await this.mcpHandlers
          .get(endpoint.mount.segment)!
          .fetch(
            request,
            principal !== undefined && token !== undefined
              ? { authInfo: this.principalToAuthInfo(principal, token) }
              : {},
          );
        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries(corsHeaders)) {
          // Vary must merge with any value the SDK already set, or a shared
          // cache keyed on the clobbered header serves the wrong variant.
          if (name === "Vary") headers.append(name, value);
          else headers.set(name, value);
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      },
    });
  }

  /** Serve the RFC 9728 document; identical for every credential state. */
  private serveMetadataDocument(
    ingress: WebIngress,
    mount: McpMount,
    issuer: string | string[] | undefined,
    corsHeaders: Record<string, string>,
  ): Response {
    const metadata = this.buildMcpResourceMetadata(
      this.resourceUrlFor(ingress, mount),
      issuer,
    );
    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",
        ...corsHeaders,
      },
    });
  }

  /**
   * Map a resolved auth outcome to the MCP wire format, or admit with null.
   *
   * The bearer refusal itself is the one both protocol mounts share; what
   * is MCP's own is the scope check on an admitted principal, which the ACP
   * mount does not have.
   */
  private refuseAuth(
    auth: Awaited<ReturnType<HttpMountContext["authenticate"]>>,
    mountAuth: HttpMountAuth,
    ingress: WebIngress,
    mount: McpMount,
    corsHeaders: Record<string, string>,
  ): Response | null {
    const refusal = refuseBearer(auth, mountAuth, {
      source: "mcp",
      context: this.host,
      corsHeaders,
      challenge: (params) =>
        this.buildWebWwwAuthenticateHeader(ingress, mount, params),
    });
    if (refusal !== null || auth === undefined || auth.kind !== "admit") {
      return refusal;
    }
    const missing = this.missingScopes(auth.principal);
    if (missing.length > 0) {
      const detail = {
        reason: "insufficient_scope",
        scheme: "bearer",
        source: "mcp",
      };
      this.host.logger.warn(detail, "Auth rejected: insufficient scope");
      this.host.emit("auth:rejected", detail);
      return Response.json(
        { error: "insufficient_scope" },
        {
          status: 403,
          headers: {
            ...corsHeaders,
            "WWW-Authenticate": this.buildWebWwwAuthenticateHeader(
              ingress,
              mount,
              { error: "insufficient_scope", scope: missing.join(" ") },
            ),
          },
        },
      );
    }
    return null;
  }

  /**
   * The public URL of the resource a mount serves. A configured
   * `resource.url` names the root; a mount below it is that URL with the
   * mount's segment appended, so each mount's metadata document identifies
   * the resource the client actually addressed.
   */
  private resourceUrlFor(ingress: WebIngress, mount: McpMount): string {
    const explicit = this.options.resource?.url;
    if (explicit !== undefined) {
      if (mount.kind === "root") return explicit.toString();
      const url = new URL(explicit.toString());
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/${mount.segment}`;
      return url.toString();
    }
    const bound = ingress.boundAddress;
    if (bound === undefined) {
      throw new TypeError("mcpPlugin: named server has not bound yet");
    }
    const hostname = bound.host.startsWith("[")
      ? bound.host
      : bound.host.includes(":")
        ? `[${bound.host}]`
        : bound.host;
    return new URL(
      this.mountPath(normalizeMcpPath(this.options.path), mount),
      `http://${hostname}:${bound.port}`,
    ).toString();
  }

  private buildWebWwwAuthenticateHeader(
    ingress: WebIngress,
    mount: McpMount,
    params: Record<string, string>,
  ): string {
    const resourceUrl = this.resourceUrlFor(ingress, mount);
    const metadataUrl = new URL(
      `${PROTECTED_RESOURCE_METADATA_PATH}${this.mountPath(normalizeMcpPath(this.options.path), mount)}`,
      resourceUrl,
    ).toString();
    const attributes = [
      `realm="mcp"`,
      ...Object.entries(params).map(([key, value]) => `${key}="${value}"`),
      `resource_metadata="${metadataUrl}"`,
    ];
    return `Bearer ${attributes.join(", ")}`;
  }

  /**
   * Start stdio transport.
   *
   * `serveStdio` calls the factory once per connection, and once more for a
   * discarded `server/discover` probe when a negotiating client checks which
   * protocol revision this server speaks. stdio carries no HTTP credentials,
   * so the instance is always built without a principal.
   */
  private async startStdio(): Promise<void> {
    const { serveStdio } = await loadMcpServerStdioSdk("mcp (stdio)");
    await this.prepareServerFactory();
    this.stdioHandle = serveStdio(() => {
      const instance = this.createServerInstance(undefined, ROOT_MOUNT);
      this.stdioServers.add(instance);
      // A closed connection is not told anything; the set holds only
      // connections a notification can still reach.
      const onclose = instance.onclose;
      instance.onclose = () => {
        this.stdioServers.delete(instance);
        onclose?.();
      };
      return instance;
    });
  }

  /**
   * Tell the stdio connections when a client's re-listing changes what this
   * server advertises: a proxied server's tools come and go with the client,
   * and a client that cached `tools/list` would otherwise call a tool that
   * is gone or never learn of one that arrived. Observed per registered
   * client, because the listing event is named per client.
   */
  private observeClientListings(): void {
    // The baseline is what a client connecting now would be told, so the
    // first listing after start, often the one that brings the proxied
    // tools, is a change and not a seed.
    this.advertisedNames = this.advertisedToolNames();
    for (const serverId of this.service.clients.keys()) {
      this.stopObservingClients.push(
        this.host.observe(
          `plugin:mcp:client:${serverId}:tools:listed` as EventName,
          () => this.notifyToolsChanged(),
        ),
      );
    }
    this.stopObservingClients.push(
      this.service.onChange(() => this.notifyToolsChanged()),
    );
  }

  /**
   * What `tools/list` would answer now, as one string: a changed name,
   * description, schema or annotation is a change a client must re-list for.
   */
  private advertisedToolNames(): string {
    return JSON.stringify(
      this.getAvailableTools().sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  private notifyToolsChanged(): void {
    const names = this.advertisedToolNames();
    if (names === this.advertisedNames) return;
    this.advertisedNames = names;
    for (const instance of this.stdioServers) {
      void Promise.resolve(instance.sendToolListChanged()).catch((error) => {
        this.host.logger.debug(
          { err: error },
          "Could not notify a stdio client of the tool list change",
        );
      });
    }
  }

  /**
   * Resolve everything the per-request factory needs, once, at startup.
   *
   * {@link createServerInstance} runs on every request, so the SDK import and
   * the identity/capability objects are hoisted out of that path: they depend
   * only on `this.options` and would otherwise be recomputed per request on
   * the axis this transport is meant to scale along.
   */
  private async prepareServerFactory(): Promise<void> {
    const { Server, ResourceNotFoundError } = await loadMcpServerSdk("mcp");
    this.sdkServerCtor = Server;
    this.resourceNotFound = ResourceNotFoundError;
    this.serverInfo = this.buildServerInfo();
    this.serverOptions = this.buildServerOptions();
  }

  /**
   * Build one MCP `Server` instance bound to a single serving unit: one HTTP
   * request under `createMcpHandler`, or one connection under `serveStdio`.
   *
   * The authenticated principal is closed over rather than read from ambient
   * request-scoped storage. Under the 2026-07-28 stateless model a request is
   * self-describing and its instance is never reused, so the principal is
   * simply a construction parameter -- which is also what makes the handler
   * safe to run on any replica.
   *
   * The era projection of a `tools/call` result runs here too, because
   * `projectCallToolResult` reads the revision this instance negotiated.
   * `handleToolCall` stays era-blind and hands back the advertisement its
   * result was produced under.
   */
  private createServerInstance(
    principal: Principal | undefined,
    mount: McpMount,
  ): SdkServer {
    if (
      !this.sdkServerCtor ||
      !this.resourceNotFound ||
      !this.serverInfo ||
      !this.serverOptions
    ) {
      throw new Error(
        "mcp: server factory used before prepareServerFactory() ran",
      );
    }
    const server = new this.sdkServerCtor(this.serverInfo, this.serverOptions);

    // Each handler casts only the member whose type is deliberately looser
    // than the SDK's generated schema: `McpTool.inputSchema.properties` is a
    // `Record<string, unknown>` because it comes from an arbitrary Standard
    // Schema, and `content` blocks are assembled by route code. The
    // surrounding result envelope stays structurally checked, so a future
    // required field on either result is a compile error rather than a
    // protocol error at a client.
    server.setRequestHandler("tools/list", () => {
      const tools = this.toolsFor(mount);
      if (mount.kind === "root") this.logExposedToolsOnce();
      return { tools: tools as unknown as ListToolsResult["tools"] };
    });

    server.setRequestHandler("tools/call", async (request) => {
      const meta = (request.params as { _meta?: Record<string, unknown> })
        ._meta;
      const { advertisedOutputSchema, ...result } = await this.handleToolCall(
        request.params.name,
        request.params.arguments ?? {},
        principal,
        mount,
        adoptTraceContext(
          {
            traceparent: stringOrUndefined(meta?.["traceparent"]),
            tracestate: stringOrUndefined(meta?.["tracestate"]),
          },
          {
            mode: this.options.traceContext,
            authenticated: principal !== undefined,
          },
        ),
      );
      return server.projectCallToolResult(
        {
          ...result,
          content: result.content as unknown as CallToolResult["content"],
        },
        advertisedOutputSchema,
      );
    });

    // A view belongs to a tool a route defines, so a client mount, which
    // lists only proxied tools, has none to serve.
    const viewEntries = (): McpLocalToolEntry[] =>
      mount.kind === "client" ? [] : this.getExposedLocalEntries();
    server.setRequestHandler("resources/list", () => ({
      resources: viewEntries()
        .filter((entry) => entry.ui !== undefined)
        .map((entry) => ({
          uri: uiResourceUri(this.options.name, entry.endpoint),
          name: entry.endpoint,
          ...(entry.title !== undefined ? { title: entry.title } : {}),
          mimeType: MCP_APP_MIME_TYPE,
        })),
    }));

    server.setRequestHandler("resources/templates/list", () => ({
      resourceTemplates: [],
    }));

    const notFound = this.resourceNotFound;
    server.setRequestHandler("resources/read", (request) =>
      this.readUiResource(request.params.uri, viewEntries(), notFound),
    );

    return server;
  }

  /**
   * Serve one MCP Apps view for `resources/read`. Only views of tools that
   * pass the `tools` filter resolve, so a hidden tool's view is as invisible
   * as the tool.
   *
   * A loader failure is logged with its cause and answered generically: a
   * file loader's error names an absolute path on this host, which is the
   * operator's to see and not the caller's.
   */
  private async readUiResource(
    uri: string,
    entries: McpLocalToolEntry[],
    notFound: typeof ResourceNotFoundError,
  ): Promise<ReadResourceResult> {
    const entry = entries.find(
      (candidate) =>
        candidate.ui !== undefined &&
        uiResourceUri(this.options.name, candidate.endpoint) === uri,
    );
    const ui = entry?.ui;
    if (entry === undefined || ui === undefined) {
      throw new notFound(uri);
    }

    let html: string;
    try {
      html = await loadUiHtml(ui);
    } catch (error) {
      const message = toolErrorLogMessage(error);
      this.host.logger.error(
        { tool: entry.endpoint, uri, err: error },
        message,
      );
      this.host.emit("plugin:mcp:ui:failed", {
        tool: entry.endpoint,
        uri,
        error: message,
      });
      throw new Error(`View for tool "${entry.endpoint}" could not be loaded`);
    }
    this.host.emit("plugin:mcp:ui:served", { tool: entry.endpoint, uri });
    return uiReadResult(uri, ui, html);
  }

  /**
   * Resolve the RFC 9728 `resource_name` value: `title` -> `name`.
   */
  private resolveResourceName(): string {
    return this.options.title ?? this.options.name;
  }

  /**
   * Build the RFC 9728 protected-resource metadata document for this MCP
   * server, through the shared core builder.
   *
   * `resourceUrl` is a required parameter rather than a default the caller
   * patches afterwards: the resolved identity depends on the bound address,
   * and a builder that returned a knowingly wrong placeholder would let any
   * future call site silently advertise it.
   *
   * `authorization_servers` is populated from the effective validator's
   * `issuer` (mount auth, else the inherited server auth). When the verifier
   * exposes no issuer, the field is omitted (RFC 9728 allows that).
   *
   * @internal
   */
  private buildMcpResourceMetadata(
    resourceUrl: string,
    issuer: string | string[] | undefined,
  ): ProtectedResourceMetadata {
    const resource = this.options.resource;
    return buildProtectedResourceMetadata({
      resource: resourceUrl,
      resourceName: this.resolveResourceName(),
      ...(issuer !== undefined ? { issuer } : {}),
      ...(resource?.scopesSupported !== undefined
        ? { scopesSupported: resource.scopesSupported }
        : {}),
      ...(resource?.documentationUrl !== undefined
        ? { documentationUrl: resource.documentationUrl.toString() }
        : {}),
    });
  }

  /**
   * Required scopes the principal does not carry, in configuration order.
   * Empty when no `requiredScopes` are configured or all are satisfied.
   */
  private missingScopes(principal: Principal): string[] {
    const required =
      this.options.auth === false
        ? undefined
        : this.options.auth?.requiredScopes;
    if (!required || required.length === 0) return [];
    const granted = new Set(principal.scopes ?? []);
    return required.filter((scope) => !granted.has(scope));
  }

  /**
   * Wrap a verified {@link Principal} as the SDK `AuthInfo` the handler passes
   * through to the per-request factory, stashing the full principal in `extra`
   * so {@link authInfoToPrincipal} recovers it losslessly on the way back out.
   *
   * The principal travels as a construction parameter of the per-request
   * server instance rather than through ambient storage: revision 2026-07-28
   * builds a fresh instance per request, so the identity can be closed over at
   * construction and there is no session for an `AsyncLocalStorage` to key on.
   *
   * `token` carries the verified bearer the caller presented. Every auth
   * helper must agree on it: the SDK hands one `AuthInfo` to every
   * per-request instance, and a consumer reading `authInfo.token` must not see
   * a real credential under `oauth()` and a placeholder under `jwt()`.
   */
  private principalToAuthInfo(
    principal: Principal,
    token: string,
  ): SdkAuthInfo {
    const authInfo: SdkAuthInfo = {
      token,
      clientId: principal.clientId ?? principal.subject,
      scopes: principal.scopes ?? [],
      extra: { principal },
    };
    if (principal.expiresAt !== undefined) {
      authInfo.expiresAt = principal.expiresAt;
    }
    return authInfo;
  }

  /** Recover the verified principal passed through the SDK request context. */
  private authInfoToPrincipal(
    authInfo: SdkAuthInfo | undefined,
  ): Principal | undefined {
    if (authInfo === undefined) return undefined;
    const principal = (authInfo.extra as { principal?: Principal } | undefined)
      ?.principal;
    if (principal !== undefined) return principal;
    return {
      kind: "oauth",
      scheme: "bearer",
      subject: authInfo.clientId,
      clientId: authInfo.clientId,
      scopes: authInfo.scopes,
      ...(authInfo.expiresAt !== undefined
        ? { expiresAt: authInfo.expiresAt }
        : {}),
    };
  }

  /**
   * Build the validator-mode token verifier, optionally wrapped with
   * `userinfo` enrichment. The base verifier is the configured `validator`;
   * when `mcpPlugin({ userinfo })` is set, it is wrapped with
   * `buildEnrichedVerifier` (token cache, in-flight coalescing, sub
   * invariant, fail-closed). The issuer for `userinfo: true` discovery comes
   * from the verifier's `issuer` (surfaced by `jwks()` / `jwt()`).
   */
  private buildValidatorVerifier():
    ((token: string) => Promise<Principal>) | null {
    const authOptions = (
      this.options.auth === false ? undefined : this.options.auth
    ) as (ValidatorAuthOptions & { issuer?: string | string[] }) | undefined;
    if (!authOptions || !("validator" in authOptions)) {
      if (this.options.userinfo !== undefined) {
        throw new TypeError(
          "mcpPlugin: userinfo requires an explicit mcp.auth validator; inherited server auth cannot be enriched",
        );
      }
      return null;
    }

    const base = (token: string): Promise<Principal> =>
      Promise.resolve(authOptions.validator(token));
    if (this.options.userinfo === undefined) return base;
    return buildEnrichedVerifier(
      base,
      this.options.userinfo,
      authOptions.issuer,
    );
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    // Unconditionally: the constructor subscribed to server:listening, so a
    // server whose prepare() failed or that never started still holds a
    // context subscription that must not outlive it.
    this.stopListeningForServer();
    for (const stop of this.stopObservingClients.splice(0)) stop();
    this.stdioServers.clear();
    if (!this.running && !this.unmountHttp && this.mcpHandlers.size === 0) {
      return;
    }

    try {
      this.unmountHttp?.();
    } catch (error) {
      this.host.logger.error({ err: error }, "Failed to unmount MCP handler");
    } finally {
      this.unmountHttp = null;
    }
    for (const [segment, handler] of this.mcpHandlers) {
      try {
        await handler.close();
      } catch (error) {
        this.host.logger.error(
          { err: error, mount: segment },
          "Failed to close mounted MCP handler",
        );
      }
    }
    this.mcpHandlers.clear();

    try {
      if (this.stdioHandle) {
        try {
          await this.stdioHandle.close();
        } catch (error) {
          this.host.logger.error(
            { err: error },
            "Failed to close MCP stdio transport",
          );
        } finally {
          this.stdioHandle = null;
        }
      }
      this.running = false;
      this.host.logger.info({}, "MCP server stopped");
    } catch (error) {
      const msg = isRoutecraftError(error)
        ? error.meta.message
        : error instanceof Error
          ? error.message
          : "Error stopping MCP server";
      this.host.logger.error({ err: error }, msg);
    }
  }

  /**
   * Log exposed MCP tool names once (at start or on first tools/list).
   */
  private logExposedToolsOnce(): void {
    if (this.toolsListLogged) return;
    const tools = this.getAvailableTools();
    if (tools.length === 0) return;
    const names = tools.map((t) => t.name);
    const exposedDetail = { tools: names, count: names.length };
    this.host.logger.info(exposedDetail, "Exposing MCP tools");
    this.host.emit("plugin:mcp:server:tools:exposed", exposedDetail);
    this.toolsListLogged = true;
  }

  /**
   * The tools one mount lists, after the `tools` filter: the root is every
   * local `.from(mcp())` route tool plus the tools the proxy routes expose.
   * Reads the MCP local tool registry lazily so routes have time to
   * subscribe before the first `tools/list` request.
   *
   * @param mount The mount's segment: the server `name` for the own mount,
   * a client id for that client's mount; omit it for the root.
   * @throws TypeError when no mount carries the segment.
   */
  getAvailableTools(mount?: string): McpTool[] {
    const found =
      mount === undefined
        ? ROOT_MOUNT
        : this.mounts().find(
            (candidate) =>
              candidate.kind !== "root" && candidate.segment === mount,
          );
    if (found === undefined) {
      throw new TypeError(`mcp: no mount named "${mount}"`);
    }
    return this.toolsFor(found);
  }

  /**
   * The mounts this server answers at: the root, the own mount named after
   * the server, and one per registered client. Each configured client gets
   * its mount whether or not a route proxies it yet, so the set is fixed
   * when the HTTP claims are made and a route starting later is served.
   */
  private mounts(): McpMount[] {
    const mounts: McpMount[] = [
      ROOT_MOUNT,
      { kind: "own", segment: this.options.name },
    ];
    for (const serverId of this.service.clients.keys()) {
      mounts.push({ kind: "client", segment: serverId });
    }
    return mounts;
  }

  /**
   * Refuse a configuration whose mounts cannot all be paths: a client named
   * after the server would share the own mount's path, and a name that is
   * not one path segment could never be addressed. HTTP only; stdio serves
   * the root alone and keeps accepting any client id.
   */
  private validateMounts(): void {
    const own = this.options.name;
    for (const mount of this.mounts()) {
      if (mount.kind === "root") continue;
      if (mount.kind === "client" && mount.segment === own) {
        throw rcError("RC5003", undefined, {
          message: `mcpPlugin: client "${mount.segment}" carries the server's own name, so both would mount at the same path`,
          suggestion:
            "Rename the client, or give the server another name; the server name and every client id become one path segment each under the MCP path.",
        });
      }
      if (!MOUNT_SEGMENT_PATTERN.test(mount.segment)) {
        throw rcError("RC5003", undefined, {
          message: `mcpPlugin: "${mount.segment}" cannot name a mount under the MCP path`,
          suggestion: `A server name or a client id becomes one path segment over HTTP and must match ${MOUNT_SEGMENT_PATTERN}.`,
        });
      }
    }
  }

  private mountPath(root: string, mount: McpMount): string {
    return mount.kind === "root" ? root : `${root}/${mount.segment}`;
  }

  private toolsFor(mount: McpMount): McpTool[] {
    return [...this.servedOn(mount).values()].map(({ entry }) =>
      this.entryToMcpTool(entry),
    );
  }

  /**
   * What a mount serves, by tool name: what `tools/list` shows and all
   * `tools/call` reaches, decided once so the two cannot disagree. The
   * root is every entry under the exposed names, a local route keeping a
   * name over a proxied tool; the own mount is the same without the star
   * routes' tools; a client mount is that client's proxied tools under
   * their remote names, judged by the `tools` filter under the names the
   * root lists them by, so a tool hidden at the root is hidden here too.
   */
  private servedOn(mount: McpMount): Map<string, McpServedTool> {
    const served = new Map<string, McpServedTool>();
    if (mount.kind === "client") {
      for (const [name, proxied] of this.clientEntries(mount.segment)) {
        if (this.passesToolsFilter(proxied.exposed)) {
          served.set(name, { entry: proxied.entry, proxied });
        }
      }
      return served;
    }
    for (const entry of this.getExposedLocalEntries()) {
      served.set(entry.endpoint, { entry });
    }
    for (const proxied of this.resolveProxied().values()) {
      const name = proxied.entry.endpoint;
      if (served.has(name)) {
        this.warnProxyOnce(
          `proxy:local-conflict:${name}`,
          "mcp({ proxy }): a proxied tool's exposed name is a local mcp() route's; the route keeps it. Give the proxy a prefix or a name to expose both.",
          {
            route: proxied.registration.routeId,
            server: proxied.registration.serverId,
            tool: proxied.remote.name,
            exposed: name,
          },
        );
        continue;
      }
      if (mount.kind === "own" && proxied.registration.tool === "*") continue;
      if (this.passesToolsFilter(proxied.entry)) {
        served.set(name, { entry: proxied.entry, proxied });
      }
    }
    return served;
  }

  /** A client mount's entries, resolved once per registry and registration version. */
  private clientEntries(serverId: string): Map<string, McpClientEntry> {
    this.syncProxyCaches();
    let entries = this.clientResolved.get(serverId);
    if (entries === undefined) {
      entries = resolveClientEntries(
        this.service,
        serverId,
        (key, message, bindings) => this.warnProxyOnce(key, message, bindings),
      );
      this.clientResolved.set(serverId, entries);
    }
    return entries;
  }

  /**
   * Whether a local tool entry passes the `tools` filter. Shared by the
   * list path (filter the whole registry) and the call path (check the one
   * looked-up entry) so a filtered-out tool is consistently invisible.
   */
  private passesToolsFilter(entry: McpLocalToolEntry): boolean {
    const toolsFilter = this.options.tools;
    if (!toolsFilter) return true;
    if (Array.isArray(toolsFilter)) return toolsFilter.includes(entry.endpoint);
    return toolsFilter(entry);
  }

  /**
   * Local route tool entries after the `tools` filter, for `resources/list`
   * (a view belongs to a tool a route defines, never to a proxied one).
   */
  private getExposedLocalEntries(): McpLocalToolEntry[] {
    return Array.from(this.service.local.values()).filter((e) =>
      this.passesToolsFilter(e),
    );
  }

  /**
   * Look up one tool by the name a mount serves it under, for `tools/call`.
   * A tool the mount does not list is not callable there, whether it is
   * filtered out or served elsewhere; a proxied tool answers with where it
   * goes, for the events.
   */
  private lookupTool(
    toolName: string,
    mount: McpMount,
  ): McpServedTool | undefined {
    return this.servedOn(mount).get(toolName);
  }

  /**
   * The tools the proxy routes expose, resolved against the clients' live
   * tool lists and memoized on the registry's change version together with
   * the registrations' version: a star route follows tool refresh and
   * stdio restarts, while steady-state requests reuse the resolution.
   */
  private resolveProxied(): Map<string, McpProxiedEntry> {
    this.syncProxyCaches();
    return this.proxyResolved;
  }

  /**
   * Re-resolve the proxied tools, and drop the client mounts' resolution,
   * when the registry or the registrations changed. A version change also
   * opens a new warning epoch so a condition that recurs after a client
   * recovered is logged again rather than silenced forever.
   */
  private syncProxyCaches(): void {
    const version = `${this.service.tools.version}:${this.service.proxiesVersion}`;
    if (version === this.proxyResolvedVersion) return;
    this.proxyWarnings.clear();
    this.clientResolved.clear();
    this.proxyResolved = resolveProxiedEntries(
      this.service,
      (key, message, bindings) => this.warnProxyOnce(key, message, bindings),
    );
    this.proxyResolvedVersion = version;
  }

  /** Log a proxy-resolution warning once per dedup key. */
  private warnProxyOnce(
    key: string,
    message: string,
    bindings: Record<string, unknown>,
  ): void {
    if (this.proxyWarnings.has(key)) return;
    this.proxyWarnings.add(key);
    this.host.logger.warn(bindings, message);
  }

  /**
   * Convert an MCP local tool registry entry to the MCP `tools/list` wire
   * format. `entry.input.body` flattens to `tool.inputSchema`; `entry.output.body`
   * flattens to `tool.outputSchema`. Header schemas are not part of the MCP
   * spec wire and are not forwarded.
   */
  private entryToMcpTool(entry: McpLocalToolEntry): McpTool {
    const tool: McpTool = {
      name: entry.endpoint,
      description: entry.description,
      inputSchema: this.schemaToJsonSchema(
        entry.input?.body,
      ) as McpTool["inputSchema"],
    };
    if (entry.title !== undefined) {
      tool.title = entry.title;
    }
    const outputSchema = this.advertisedOutputSchema(entry);
    if (outputSchema !== undefined) {
      tool.outputSchema = outputSchema as NonNullable<McpTool["outputSchema"]>;
    }
    if (entry.annotations !== undefined) {
      tool.annotations = entry.annotations;
    }
    const icons = entry.icons ?? this.resolveServerIcons();
    if (icons.length > 0) {
      tool.icons = icons;
    }
    if (entry.ui !== undefined) {
      tool._meta = {
        ui: { resourceUri: uiResourceUri(this.options.name, entry.endpoint) },
      };
    }
    return tool;
  }

  /**
   * The JSON Schema this server advertises as a local tool's `outputSchema`,
   * or undefined when the route declares no `.output({ body })`.
   *
   * This is the natural (unprojected) schema. The SDK's wire codec owns both
   * era projections of it: `encodeResult('tools/list')` wraps a non-object
   * root down to `{type:'object', properties:{result:<natural>}}` on the 2025
   * era, and `projectCallToolResult` wraps the matching value the same way.
   * Handing either side a pre-wrapped schema would wrap it twice.
   *
   * A deferrable tool answers a deferred run with the `Deferred`
   * acknowledgment instead of its declared output, so its contract is the
   * union of both arms and advertising only the first would publish a schema
   * this server violates on every deferral. The arms are disjoint by construction
   * (`status: "deferred"` is const in the acknowledgment arm and reserved in
   * no user schema the framework mints), so `oneOf` is exact.
   */
  private advertisedOutputSchema(
    entry: McpLocalToolEntry,
  ): Record<string, unknown> | undefined {
    if (this.outputSchemaJson.has(entry)) {
      return this.outputSchemaJson.get(entry);
    }
    const arms = advertisedOutputArms(entry);
    const schema =
      arms.length === 0
        ? undefined
        : arms.length === 1
          ? this.schemaToJsonSchema(arms[0])
          : { oneOf: arms.map((arm) => this.schemaToJsonSchema(arm)) };
    this.outputSchemaJson.set(entry, schema);
    return schema;
  }

  /**
   * Convert to JSON Schema using Standard JSON Schema (schema['~standard'].jsonSchema.input)
   * when available; otherwise return a generic object schema.
   * Works with any spec-compliant library (Zod 4.2+, ArkType, Valibot via toStandardJsonSchema).
   */
  private schemaToJsonSchema(schema: unknown): Record<string, unknown> {
    if (!schema || typeof schema !== "object") {
      return { type: "object" };
    }

    const standard = (schema as Record<string, unknown>)["~standard"] as
      | {
          jsonSchema?: {
            input?: (opts: { target: string }) => Record<string, unknown>;
          };
        }
      | undefined;
    if (standard?.jsonSchema?.input) {
      try {
        const out = standard.jsonSchema.input({
          target: "draft-2020-12",
        });
        return typeof out === "object" && out !== null
          ? out
          : { type: "object" };
      } catch (error) {
        this.host.logger.debug(error, "Standard JSON Schema conversion failed");
        return { type: "object" };
      }
    }

    if ("~standard" in schema) {
      return { type: "object", additionalProperties: true };
    }
    return { type: "object" };
  }

  /**
   * Report a declined tool call: the route ran and chose not to answer.
   *
   * Kept off the failure path deliberately. Core models a drop as its own
   * lifecycle outcome beside completed and failed, and a tool whose job is to
   * filter would otherwise write an error-level line and a `tool:failed`
   * event on every ordinary rejection, paging anyone with an error-rate alert
   * on normal traffic. MCP has no channel but `isError` to tell the caller,
   * so the wire result matches a failure while the log and the event do not.
   */
  private declineToolCall(
    toolName: string,
    error: Error,
    provenance: McpToolStamp,
  ): McpToolCallResult {
    const message = toolErrorLogMessage(error);
    this.host.logger.warn({ tool: toolName, err: error }, message);
    this.host.emit(`plugin:mcp:tool:declined`, {
      ...provenance,
      tool: toolName,
      reason: message,
    });

    return toolErrorResult(message);
  }

  /**
   * Handle a tool call from MCP client. Resolves local route tools first
   * (after the `tools` filter, so a filtered-out tool is not callable),
   * then tools proxied from registered clients.
   */
  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    principal: Principal | undefined,
    mount: McpMount = ROOT_MOUNT,
    trace: AdoptedTraceHeaders = {},
  ): Promise<McpToolCallResult> {
    let admitted: Principal | undefined;
    const where: McpToolMount =
      mount.kind === "root" ? {} : { mount: mount.segment };
    let provenance: McpToolStamp = { ...where };
    // The route that ran: the tool's own for a local tool, the proxy route
    // for a proxied one. What a refusal is classified against.
    let routeId = toolName;
    try {
      // Normalize args once (the SDK may pass a parsed object or a raw JSON
      // string). MCP tool arguments are always a JSON object; a primitive,
      // array, or null (however it arrives) is coerced to the safe fallback
      // shape before the route consumes it, so downstream code can trust a
      // record.
      const body = normalizeToolArgs(args);

      const found = this.lookupTool(toolName, mount);
      if (!found) {
        const err = new Error(`Tool not found: ${toolName}`);
        this.host.emit(`plugin:mcp:tool:failed`, {
          ...where,
          tool: toolName,
          error: err.message,
        });
        return toolErrorResult(err.message);
      }
      const { entry } = found;
      // Where a proxied call goes, on every event of the call, so called,
      // completed and failed stay correlatable per client.
      if (found.proxied) {
        routeId = found.proxied.registration.routeId;
        provenance = {
          ...where,
          proxied: true,
          serverId: found.proxied.registration.serverId,
          remoteTool: found.proxied.remote.name,
          routeId,
        };
      }

      this.host.logger.debug(
        { bodyType: typeof body, body },
        "MCP tool call exchange body",
      );

      // Build exchange headers. The authenticated principal (when present)
      // rides as a single structured header rather than ten flat keys; the
      // `ex.principal` getter on the exchange surfaces it ergonomically.
      // This is the single attach point for every MCP auth mode (jwt/jwks/
      // custom validator and `oauth()`) and runs after any userinfo
      // enrichment, so branding here marks the verified identity as
      // authentic for downstream `authorize()` without freezing it too
      // early to enrich.
      const headers: Record<string, unknown> = {
        ...trace,
        [McpHeadersKeys.TOOL]: toolName,
        [McpHeadersKeys.REQUEST]: crypto.randomUUID(),
      };
      if (principal) {
        admitted = this.host.authority.brand(principal);
        headers[HeadersKeys.AUTH_PRINCIPAL] = admitted;
      }

      this.host.emit(`plugin:mcp:tool:called`, {
        ...provenance,
        tool: toolName,
        // Deep snapshot: the live body is handed to the route handler next
        // and may be mutated (including nested values) after emission.
        args: structuredClone(body),
      });

      const resultExchange = await entry.handler({
        body,
        headers: headers as ExchangeHeaders,
      });

      // A decline is the route's answer, not a failure, so it returns here
      // rather than throwing into the catch below.
      const declined = declinedError(entry, resultExchange);
      if (declined) {
        return this.declineToolCall(toolName, declined, provenance);
      }

      // Publishes what the schema accepted, not what the handler offered:
      // for a transforming schema those differ, and the client was promised
      // the schema's output.
      const publishedBody = await enforceAdvertisedOutput(
        entry,
        resultExchange,
      );

      const resultText =
        typeof publishedBody === "string"
          ? publishedBody
          : JSON.stringify(publishedBody);

      // A deferred run is neither finished nor failed: reporting it as
      // `completed` would publish a false receipt to every dashboard, the
      // same honesty rule that gave SerializedOutcome its distinct
      // "deferred" status and declines their own event (#576).
      if (isDeferred(publishedBody)) {
        this.host.emit(`plugin:mcp:tool:deferred`, {
          ...provenance,
          tool: toolName,
          deferralId: publishedBody.deferralId,
        });
      } else {
        this.host.emit(`plugin:mcp:tool:completed`, {
          ...provenance,
          tool: toolName,
        });
      }

      // A tool that advertises an outputSchema (the route declares .output())
      // MUST return structuredContent per the MCP spec; spec-compliant clients
      // reject the response otherwise. The text block stays alongside it for
      // non-structured clients, as the spec recommends. The body's runtime
      // shape does not enter into it: a declared string or array is published
      // as-is, and the wire seam wraps it to match the projection the same era
      // applied to the advertisement carried back beside it.
      const advertisedOutputSchema = this.advertisedOutputSchema(entry);
      // A proxied call whose route left the hop's result alone answers with
      // the remote's result as published: its content blocks (images,
      // resources, several texts) with their MIME types, its
      // structuredContent and its _meta. Re-serialising the body would turn
      // an image into its base64 as text and drop the rest.
      const unaltered =
        found.proxied === undefined
          ? undefined
          : takeUnalteredHopResult(resultExchange.id, publishedBody);
      const content =
        unaltered?.content !== undefined && unaltered.content.length > 0
          ? unaltered.content
          : [{ type: "text", text: resultText }];
      const result: McpToolCallResult = { content };
      if (advertisedOutputSchema !== undefined) {
        result.structuredContent =
          unaltered?.structuredContent ?? publishedBody;
        result.advertisedOutputSchema = advertisedOutputSchema;
      }
      const meta = unaltered?.["_meta"];
      if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
        result._meta = meta as Record<string, unknown>;
      }
      return result;
    } catch (error) {
      const origin: CallerRefusalOrigin = {
        routeId,
        principal: admitted,
        credentialCouldHelp: this.acceptsCredentials && admitted === undefined,
      };
      const logMsg = toolErrorLogMessage(error);
      // A refusal the caller caused is answered, not an instance fault, and route.runSteps already logged it.
      const classified = callerRefusalOf(error, origin);
      // An MCP caller sends no headers, so a headers refusal is the route's own.
      const refusal =
        classified?.kind === "input" && classified.in === "headers"
          ? undefined
          : classified;
      const level = refusal === undefined ? "error" : "debug";
      this.host.logger[level]({ tool: toolName, err: error }, logMsg);
      this.host.emit(`plugin:mcp:tool:failed`, {
        ...provenance,
        tool: toolName,
        error: logMsg,
      });

      return toolErrorResult(
        toolFailureText(toolName, error, refusal, origin.routeId),
      );
    }
  }
}

/** A `_meta` value kept only when it is a string. */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
