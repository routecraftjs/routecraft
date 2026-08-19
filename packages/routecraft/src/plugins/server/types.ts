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
   * force-closed, in milliseconds. Defaults to 30000.
   */
  shutdownGraceMs?: number;
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
   * Mount-level auth override. Unset inherits the server's validator;
   * `false` opts out explicitly so an open surface on an authenticated
   * server is always a visible config decision.
   */
  readonly auth?: HttpAuth | false;
  /**
   * Responses on this mount may stream or stay quiet indefinitely (MCP
   * streamable HTTP, SSE). The ingress exempts its requests from the
   * listener's idle timeout so a silent stream is not reaped, while every
   * other connection keeps the bounded default.
   */
  readonly longLived?: boolean;
  readonly handler: (
    request: Request,
    context: HttpMountContext,
  ) => Response | Promise<Response>;
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
}

export interface WebIngress {
  readonly serverName: string;
  readonly serverAuthConfigured: boolean;
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
