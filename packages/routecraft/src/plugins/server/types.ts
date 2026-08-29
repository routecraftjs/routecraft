import type { Duration } from "../../shared/duration.ts";
import type { HttpAuth, HttpMethod } from "../../adapters/http/types.ts";
import type { ValidatorAuthOptions } from "../../auth/types.ts";
import type { AuthResult } from "../http/auth.ts";
import type { PathMatcher } from "../http/path-matcher.ts";

export interface HttpServerDefinition {
  kind?: "http";
  host?: string;
  port: number;
  /**
   * Server-level credential validator inherited by every mount that does not
   * set its own `auth`. Verification config only: each mount still owns its
   * admission policy and refusal wire format.
   */
  auth?: ValidatorAuthOptions;
  /**
   * How long a graceful close may drain in-flight work before the listener is
   * force-closed. Defaults to 30000.
   */
  shutdownGrace?: Duration;
  /**
   * How long a connection may sit idle before the listener reaps it.
   * Defaults to `"255s"`, which is Bun's maximum and so the ceiling on both
   * runtimes: a larger value is refused at construction rather than silently
   * clamped, because a config that means one thing on Bun and another on
   * Node is worse than a config that will not start.
   *
   * Streaming responses are exempt from this per request, and bounded by
   * {@link HttpServerDefinition.maxStreamingRequests} instead.
   */
  idleTimeout?: Duration;
  /**
   * How many streaming responses this listener will carry at once, past
   * which it answers 503 with `Retry-After`. Defaults to 500.
   *
   * A backstop, not a capacity plan: a streaming response is exempt from the
   * idle reaper, so without a ceiling a client that opens streams and never
   * reads them takes the process to its file-descriptor limit and every
   * in-flight request with it. The number is meant to sit below that cliff so
   * an operator gets a clean refusal instead, the way `maxBodySize`'s 10 MB
   * does. Per-route admission is a different tool: see `.concurrency()`.
   *
   * Deliberately not named for HTTP/2's `SETTINGS_MAX_CONCURRENT_STREAMS`,
   * which counts multiplexed streams inside one connection and is a
   * different thing entirely.
   */
  maxStreamingRequests?: number;
}

export type ServerDefinitions = Record<string, HttpServerDefinition>;

export type PathClaim =
  | {
      readonly kind: "exact";
      readonly path: string;
      readonly methods?: readonly HttpMethod[];
    }
  | {
      readonly kind: "prefix";
      readonly path: string;
    }
  | {
      readonly kind: "pattern";
      readonly matcher: PathMatcher;
      readonly staticPrefix: string;
      readonly methods?: readonly HttpMethod[];
    };

export interface HttpMount {
  readonly id: string;
  /**
   * Every path this mount answers, evaluated once during the server's
   * `start()` validation. The thunk exists so claims registered after mount
   * time (route subscriptions) are visible at validation; the evaluated set
   * is the immutable routing input afterwards.
   *
   * `{ kind: "prefix", path: "/" }` is the catch-all fallback: it loses to
   * every other claim at dispatch and at most one mount per server may
   * declare it.
   */
  readonly claims: () => readonly PathClaim[];
  /**
   * Mount-level auth override. Unset inherits the server's validator as this
   * mount's effective auth. A config of its own replaces the server's.
   * `false` removes the wall while keeping the inherited validator reachable
   * for pull-based verification (a route's `.authorize()`), so an open
   * surface on an authenticated server is a visible config decision that
   * never strands routes needing identity.
   */
  readonly auth?: HttpAuth | false;
  /**
   * Whether this surface enforces the resolved wall. Defaults to true. The
   * ops surface sets false because its health paths answer every probe
   * without a credential whatever the facts say; the registry uses this to
   * keep the inherited-authentication log from claiming a gate the surface
   * never enforces.
   */
  readonly enforcesWall?: boolean;
  /**
   * Responses on this mount may stream or stay quiet indefinitely (MCP
   * streamable HTTP, SSE). The ingress exempts its requests from the
   * listener's idle timeout so a silent stream is not reaped, while every
   * other connection keeps the bounded default.
   */
  readonly longLived?: boolean;
  /**
   * What the RFC 9728 metadata document for this mount's paths may say
   * beyond the effective validator's issuer. Declared, never inferred: the
   * ops mount passes its resolved tier scopes here, and a mount that
   * declares nothing gets a document carrying only what the validator
   * config states. Served by the ingress for any metadata path no mount
   * claims itself (the MCP mount claims and serves its own).
   */
  readonly resourceMetadata?: {
    readonly scopesSupported?: readonly string[];
  };
  readonly handler: (
    request: Request,
    context: HttpMountContext,
  ) => Response | Promise<Response>;
}

/**
 * Resolved auth facts for a mount: which validator is effective and whether
 * the author asked for a wall. Facts, not policy: the registry computes them
 * in one place so no surface re-derives the rule, and each surface decides
 * for itself whether to honour `walled` (http and mcp do; ops never walls its
 * health paths).
 */
export interface HttpMountAuth {
  /**
   * Only three combinations are reachable, one per spelling of `auth`:
   * unset resolves { own: false, optedOut: false, walled: configured },
   * a config of its own { own: true, optedOut: false, configured: true,
   * walled: true }, and `false` { own: false, optedOut: true, walled: false }.
   */
  /** An effective validator exists (the mount's own, or inherited). */
  readonly configured: boolean;
  /** The mount declared its own validator rather than inheriting. */
  readonly own: boolean;
  /** The mount said `auth: false`: no wall, inherited validator reachable. */
  readonly optedOut: boolean;
  /** `configured && !optedOut`. The author asked for a wall. */
  readonly walled: boolean;
}

/**
 * Resolved facts about the mount's effective auth (mount `auth`, else the
 * inherited server validator), so protocol handlers never re-parse the raw
 * config union at request time.
 */
export interface HttpMountAuthPolicy {
  /** Issuer(s) the effective validator advertises, for metadata documents. */
  readonly issuer?: string | string[];
}

export interface HttpMountContext {
  readonly serverName: string;
  /**
   * Resolve this request's credential through the mount's effective auth.
   * Memoized per request, and the ingress emits `auth:success` /
   * `auth:rejected` exactly once, on first resolution. Returns `undefined`
   * when the mount has no effective auth.
   *
   * The ingress never calls this itself: the mount owns its gate, so public
   * protocol paths (discovery documents, health probes, CORS preflight) and
   * routes that opt out of auth simply never trigger verification.
   */
  readonly authenticate: () => Promise<AuthResult | undefined>;
  readonly authPolicy: HttpMountAuthPolicy | undefined;
  /** Resolved auth facts for this mount. */
  readonly auth: HttpMountAuth;
  /**
   * Claim a streaming slot for this one request.
   *
   * Two things at once, because they are the same decision: the request is
   * exempted from the listener's idle reaper, and it is counted against
   * `maxStreamingRequests`. The mount-level {@link HttpMount.longLived} flag
   * says every request on a surface may stay quiet; this says one of them
   * will, which is what a mount needs when the body type decides.
   *
   * Returns a release callback to call when the response ends, or
   * `undefined` when the listener is already at its cap, in which case the
   * caller must refuse rather than stream.
   */
  readonly claimStreamingSlot: () => (() => void) | undefined;
}

export interface WebIngress {
  readonly serverName: string;
  /**
   * Resolve the auth facts a mount option would get on this server. Pure in
   * the option and the server's own validator, so a surface can consult it
   * before or after mounting (bind-time refusals, startup warnings) and the
   * request-time `HttpMountContext.auth` is guaranteed to agree.
   */
  resolveMountAuth(auth: HttpMount["auth"]): HttpMountAuth;
  /**
   * Whether a mount with this id is registered on the same server.
   *
   * Only meaningful from inside a `claims()` thunk, which the server evaluates
   * once every mount has registered. It exists so a surface can stand down for
   * one that supersedes it, rather than colliding at bind time over a path
   * both would answer.
   */
  hasMount(id: string): boolean;
  readonly boundAddress:
    { readonly host: string; readonly port: number } | undefined;
  mountHttp(mount: HttpMount): () => void;
}
