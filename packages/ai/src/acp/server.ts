/**
 * The Agent Client Protocol over Streamable HTTP, mounted beside MCP on
 * the same server and behind the same wall.
 *
 * The mount owns the door: it authenticates every request before the SDK
 * sees one, and it is what binds a connection to the person who opened it.
 * Everything past that is the SDK's transport and this package's handlers.
 */

import {
  buildCorsHeaders,
  bearerChallenge,
  normalizeStaticPathPrefix,
  rcError,
  requireWebIngress,
  resolveCorsOptions,
  type CraftContext,
  type HttpMountAuth,
  type HttpMountContext,
  type PathClaim,
  type WebIngress,
} from "@routecraft/routecraft";
import { AcpConnection, buildAcpApp } from "./app.ts";
import { AcpRuntime } from "./runtime.ts";
import { loadAcpSdk, loadAcpServerSdk } from "./sdk.ts";
import type { AcpPluginOptions } from "./types.ts";

/** The header the SDK stamps on an initialize response and expects back. */
const CONNECTION_ID_HEADER = "Acp-Connection-Id";

/**
 * Request header naming the agent a connection wants to talk to.
 *
 * The protocol has no field for it. A client that names one gets it for
 * every conversation it opens on that connection; a client that names
 * nothing gets the mount's own default. Exported so the bridge and this
 * mount cannot disagree about the spelling.
 */
export const ACP_AGENT_HEADER = "Routecraft-Agent";

/** Mount path when the app names none. */
const DEFAULT_PATH = "/acp";

/**
 * Normalize and refuse a path that cannot be a mount.
 *
 * The root is refused for the same reason the MCP mount refuses it: a
 * surface claiming `/` would answer every request the server has, and an
 * app that meant that says so with a reverse proxy instead.
 */
export function normalizeAcpPath(raw: string): string {
  const path = normalizeStaticPathPrefix(raw, "acpPlugin");
  if (path === "/") {
    throw new TypeError(
      'acpPlugin: path must not be "/". Mount the ACP endpoint under a non-root path such as "/acp".',
    );
  }
  return path;
}

/** What the mount remembers about one open connection. */
interface ConnectionRecord {
  readonly connection: AcpConnection;
  /** The subject that opened it, or `null` when nobody was authenticated. */
  readonly owner: string | null;
}

/**
 * The ACP HTTP surface for one context.
 *
 * Built in the plugin's `apply()` so a misconfiguration fails the context
 * build, and mounted before any listener binds, exactly as the MCP server
 * does it.
 */
export class AcpServer {
  private unmount: (() => void) | undefined;
  /** Connections by the SDK's own id, so a later request finds its owner. */
  private readonly connections = new Map<string, ConnectionRecord>();
  private server:
    | Awaited<ReturnType<typeof loadAcpServerSdk>>["AcpServer"]["prototype"]
    | undefined;

  constructor(
    private readonly context: CraftContext,
    private readonly runtime: AcpRuntime,
    private readonly options: AcpPluginOptions,
  ) {}

  /** Load the optional peer and register the mount. */
  async prepare(): Promise<void> {
    const acp = await loadAcpSdk("acp (mount)");
    const { AcpServer: SdkServer } = await loadAcpServerSdk("acp (mount)");
    const path = normalizeAcpPath(this.options.path ?? DEFAULT_PATH);
    const cors = resolveCorsOptions(this.options.cors);
    const ingress = requireWebIngress(this.context, this.options.server);

    // Every connection is built by the request that opened it, through
    // `handleRequest`'s own per-call factory. The mount must never hold the
    // caller between the two: the SDK reads and parses the request body
    // before it reaches this factory, so a second initialize arriving in
    // that window would be the one whose principal a shared slot held, and
    // the connection would run every turn as somebody else.
    const server = new SdkServer({
      createAgent: () => {
        throw rcError("RC5003", undefined, {
          message:
            "ACP connections are built per request, so this factory is never the one that runs. " +
            "Reaching it means a request opened a connection without a principal.",
        });
      },
    });
    this.server = server;

    const claims: PathClaim[] = [
      {
        kind: "exact",
        path,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
      },
      {
        kind: "exact",
        path: `${path}/`,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
      },
    ];

    this.unmount = ingress.mountHttp({
      id: "acp",
      // The GET channel is held open and legitimately quiet between
      // turns; without the exemption the listener's idle reaper cuts it.
      longLived: true,
      ...(this.options.auth !== undefined ? { auth: this.options.auth } : {}),
      claims: () => claims,
      handler: async (request, mountContext) => {
        const url = new URL(request.url);
        const origin = request.headers.get("origin") ?? undefined;
        const corsHeaders = buildCorsHeaders(cors, origin, false);

        if (request.method === "OPTIONS" && cors !== null) {
          return new Response(null, {
            status: 204,
            headers: buildCorsHeaders(cors, origin, true),
          });
        }
        // A browser whose origin the policy does not allow is refused here
        // rather than served and left to discard the answer. The preflight
        // already stops the shapes that get preflighted; this closes the
        // ones that do not, so a cross-origin page cannot drive a turn on
        // somebody's loopback instance and simply ignore the reply. A
        // caller with no Origin at all is not a browser and is unaffected,
        // which is every editor.
        if (
          origin !== undefined &&
          cors !== null &&
          corsHeaders["Access-Control-Allow-Origin"] === undefined
        ) {
          this.context.logger.debug(
            { origin, source: "acp" },
            "ACP request refused: origin is not allowed by this mount's CORS policy",
          );
          return Response.json(
            { error: "Forbidden" },
            { status: 403, headers: corsHeaders },
          );
        }
        if (url.pathname !== path && url.pathname !== `${path}/`) {
          return Response.json(
            { error: "Not Found", path: url.pathname },
            { status: 404, headers: corsHeaders },
          );
        }

        const auth = await mountContext.authenticate();
        const refusal = this.refuse(
          auth,
          mountContext.auth,
          request.url,
          corsHeaders,
        );
        if (refusal) return refusal;
        const principal = auth?.kind === "admit" ? auth.principal : undefined;

        // A request on an existing connection has to come from the person
        // who opened it. The credential is verified above whatever else
        // happens; this is what stops a second valid credential steering
        // somebody else's conversation.
        const existing = request.headers.get(CONNECTION_ID_HEADER);
        if (existing !== null) {
          const record = this.connections.get(existing);
          if (
            record !== undefined &&
            record.owner !== (principal?.subject ?? null)
          ) {
            this.context.logger.warn(
              { connectionId: existing, source: "acp" },
              "ACP request presented a credential for another connection's owner",
            );
            return Response.json(
              { error: "Forbidden" },
              { status: 403, headers: corsHeaders },
            );
          }
        }

        // Request-scoped, so the principal this connection is built with is
        // this request's own however many others are in flight.
        let opened: AcpConnection | undefined;
        const response = await server.handleRequest(request, {
          createAgent: () => {
            const connection = new AcpConnection(
              this.runtime,
              this.options,
              principal,
              acp,
              request.headers.get(ACP_AGENT_HEADER) ?? undefined,
            );
            opened = connection;
            return buildAcpApp(connection, () =>
              acp.agent({ name: "routecraft" }),
            );
          },
        });
        const connectionId = response.headers.get(CONNECTION_ID_HEADER);
        if (connectionId !== null && opened !== undefined) {
          const connection = opened;
          this.connections.set(connectionId, {
            connection,
            owner: principal?.subject ?? null,
          });
          connection.onClosed(() => {
            // Only if the entry is still this connection's: a reconnect
            // reusing the id must not have its record swept by the old one.
            if (this.connections.get(connectionId)?.connection === connection) {
              this.connections.delete(connectionId);
            }
          });
        }
        if (request.method === "DELETE" && existing !== null) {
          this.connections.delete(existing);
        }

        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries(corsHeaders)) {
          // Vary merges rather than replaces, or a shared cache keyed on
          // the clobbered header serves the wrong variant.
          if (name === "Vary") headers.append(name, value);
          else headers.set(name, value);
        }
        return new Response(openedEagerly(response), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      },
    });
  }

  /** Close every connection and release the mount. */
  async stop(): Promise<void> {
    for (const { connection } of this.connections.values()) connection.close();
    this.connections.clear();
    await this.server?.close();
    this.unmount?.();
    this.unmount = undefined;
  }

  /**
   * Map a resolved auth outcome to a refusal, or admit.
   *
   * The shared middleware already classified the failure and the ingress
   * emitted its event; this decides what the protocol surface does about
   * it. ACP has no anonymous mode on a walled mount, so an absent
   * credential is a refusal here even though an http route would admit it.
   */
  private refuse(
    auth: Awaited<ReturnType<HttpMountContext["authenticate"]>>,
    mountAuth: HttpMountAuth,
    requestUrl: string,
    corsHeaders: Record<string, string>,
  ): Response | null {
    if (auth === undefined) return null;
    if (mountAuth.optedOut) {
      // No wall: a rejected credential is served anonymously, never worse
      // than presenting none. An infrastructure failure is still a 500,
      // because a broken validator is a server-side outage either way.
      if (auth.kind === "absent") return null;
      if (auth.kind === "reject" && auth.reason !== "infrastructure") {
        this.context.logger.debug(
          { reason: auth.reason, scheme: "bearer", source: "acp" },
          "Auth rejected on an unwalled mount; serving anonymously",
        );
        return null;
      }
    }
    if (auth.kind === "reject") {
      if (auth.reason === "infrastructure") {
        this.context.logger.warn(
          { reason: auth.reason, scheme: "bearer", source: "acp" },
          "Auth unavailable: validator failed",
        );
        return Response.json(
          { error: "Authentication unavailable" },
          { status: 500, headers: corsHeaders },
        );
      }
      // Routine handshake noise stays at debug so `warn` keeps meaning a
      // token that failed for a reason worth looking at: clients present a
      // stale cached token and refresh, and a non-bearer scheme is a probe.
      const routine =
        auth.reason === "unsupported_scheme" || auth.reason === "expired";
      const detail = { reason: auth.reason, scheme: "bearer", source: "acp" };
      if (routine) {
        this.context.logger.debug(detail, "Auth rejected: token not usable");
      } else {
        this.context.logger.warn(
          detail,
          "Auth rejected: token validation failed",
        );
      }
      return unauthorized(requestUrl, corsHeaders, { error: "invalid_token" });
    }
    if (auth.kind === "absent") {
      const detail = {
        reason: "missing_header",
        scheme: "bearer",
        source: "acp",
      };
      this.context.logger.debug(
        detail,
        "Auth rejected: missing or malformed Authorization header",
      );
      this.context.emit("auth:rejected", detail);
      // RFC 6750 section 3: a request that carried no credential gets a
      // bare challenge, not `invalid_token`.
      return unauthorized(requestUrl, corsHeaders);
    }
    return null;
  }
}

/**
 * An event stream that says hello before it has anything to say.
 *
 * A response whose body is a `ReadableStream` does not put its headers on
 * the wire until the first chunk, and a freshly opened ACP session stream
 * has nothing to send until the turn produces something. The client waits
 * for that response before it will post the prompt, so the two wait for
 * each other: the prompt never arrives, so the stream never emits, so the
 * headers never flush. The SDK's own keep-alive would break it after
 * fifteen seconds, which is not a fix.
 *
 * One SSE comment, which the format defines as a no-op and every parser
 * discards, is enough to flush the headers at once. Back-pressure is
 * preserved: everything after the comment is pulled from the source
 * exactly as before.
 */
function openedEagerly(response: Response): ReadableStream<Uint8Array> | null {
  const body = response.body;
  if (
    body === null ||
    !(response.headers.get("content-type") ?? "").includes("text/event-stream")
  ) {
    return body;
  }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(SSE_COMMENT);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason: unknown) {
      // Returned rather than discarded, so the stream owns the settlement
      // and a reader that refuses to cancel is not an unhandled rejection.
      return reader.cancel(reason);
    },
  });
}

/** The SDK's own keep-alive comment, which is the smallest legal SSE frame. */
const SSE_COMMENT = new TextEncoder().encode(":\n\n");

/**
 * RFC 6750 401, hinting through the one builder every routecraft surface
 * refuses with.
 *
 * `bearerChallenge` is what appends the RFC 9728 `resource_metadata` URL the
 * CLI follows to name the issuer and the scope a caller is missing. A
 * hand-rolled challenge still parses and simply says less, which is the
 * failure the shared builder exists to prevent.
 */
function unauthorized(
  requestUrl: string,
  corsHeaders: Record<string, string>,
  params: Record<string, string> = {},
): Response {
  return Response.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: {
        ...corsHeaders,
        "WWW-Authenticate": bearerChallenge({ requestUrl, params }),
      },
    },
  );
}

/** Refuse a mount whose ingress is missing, with the servers that exist. */
export function assertIngress(
  context: CraftContext,
  server: string | undefined,
): WebIngress {
  try {
    return requireWebIngress(context, server);
  } catch (cause: unknown) {
    throw rcError("RC5003", cause, {
      message: `acpPlugin needs an http server to mount on and this context has no server named "${server ?? "default"}".`,
    });
  }
}
