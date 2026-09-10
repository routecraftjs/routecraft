/**
 * What a protocol mount does about a bearer credential the ingress could
 * not admit, once, for both of them.
 *
 * The shared middleware has already classified the failure and emitted its
 * event for the reject arm; this decides the answer on the wire and the
 * log line, so the MCP and ACP mounts cannot drift on what an
 * unauthenticated caller is told. Neither protocol has an anonymous mode on
 * a walled mount, so an absent credential is a refusal here even though an
 * http route would admit it, and it is this function that emits for that
 * arm because it is only a refusal on these surfaces.
 */

import type {
  CraftContext,
  HttpMountAuth,
  HttpMountContext,
} from "@routecraft/routecraft";

/** The outcome the ingress resolved for the request's credential. */
export type ResolvedAuth = Awaited<
  ReturnType<HttpMountContext["authenticate"]>
>;

export interface BearerRefusalSite {
  /** Which mount, for the log line and the event. */
  readonly source: "acp" | "mcp";
  readonly context: CraftContext;
  /** Headers every answer carries, so a refused browser can still read it. */
  readonly corsHeaders: Record<string, string>;
  /** The RFC 6750 challenge for this mount, given the params of the refusal. */
  readonly challenge: (params: Record<string, string>) => string;
}

/**
 * Map a resolved auth outcome to the refusal a protocol mount answers
 * with, or `null` to admit.
 *
 * On a mount that opted out of the wall a rejected credential is served
 * anonymously, never worse than presenting none; an infrastructure failure
 * is still a 500, because a broken validator is a server-side outage
 * either way. Routine handshake noise stays at debug so `warn` keeps
 * meaning a token that failed for a reason worth looking at: clients
 * present a stale cached token and refresh, and a non-bearer scheme is a
 * probe.
 */
export function refuseBearer(
  auth: ResolvedAuth,
  mountAuth: HttpMountAuth,
  site: BearerRefusalSite,
): Response | null {
  if (auth === undefined) return null;
  const { context, source, corsHeaders } = site;
  if (mountAuth.optedOut) {
    if (auth.kind === "absent") return null;
    if (auth.kind === "reject" && auth.reason !== "infrastructure") {
      context.logger.debug(
        { reason: auth.reason, scheme: "bearer", source },
        "Auth rejected on an unwalled mount; serving anonymously",
      );
      return null;
    }
  }
  if (auth.kind === "reject") {
    const detail = { reason: auth.reason, scheme: "bearer", source };
    if (auth.reason === "infrastructure") {
      context.logger.warn(detail, "Auth unavailable: validator failed");
      return Response.json(
        { error: "Authentication unavailable" },
        { status: 500, headers: corsHeaders },
      );
    }
    if (auth.reason === "unsupported_scheme") {
      context.logger.debug(
        detail,
        "Auth rejected: unsupported authorization scheme",
      );
    } else if (auth.reason === "expired") {
      context.logger.debug(detail, "Auth rejected: token expired");
    } else {
      context.logger.warn(detail, "Auth rejected: token validation failed");
    }
    return unauthorized(site, { error: "invalid_token" });
  }
  if (auth.kind === "absent") {
    const detail = { reason: "missing_header", scheme: "bearer", source };
    context.logger.debug(
      detail,
      "Auth rejected: missing or malformed Authorization header",
    );
    context.emit("auth:rejected", detail);
    // RFC 6750 section 3: a request that carried no credential gets a
    // bare challenge, not `invalid_token`.
    return unauthorized(site);
  }
  return null;
}

/** RFC 6750 401 with the challenge params for this specific refusal. */
function unauthorized(
  site: BearerRefusalSite,
  params: Record<string, string> = {},
): Response {
  return Response.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: {
        ...site.corsHeaders,
        "WWW-Authenticate": site.challenge(params),
      },
    },
  );
}
