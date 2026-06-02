import type { Exchange } from "../../exchange";
import type {
  OAuthValidatorAuthOptions,
  Principal,
  ValidatorAuthOptions,
} from "../../auth/types";

/** HTTP request methods supported by both the destination and the source. */
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

/** Query string values accepted by the destination's `query` option. */
export type QueryParams = Record<string, string | number | boolean>;

// --------------------------------------------------------------------------
// Destination (client side). Option type named per the Server/Client
// convention for two-sided adapters.
// --------------------------------------------------------------------------

export interface HttpClientOptions<T = unknown> {
  method?: HttpMethod;
  url: string | ((exchange: Exchange<T>) => string);
  headers?:
    | Record<string, string>
    | ((exchange: Exchange<T>) => Record<string, string>);
  query?: QueryParams | ((exchange: Exchange<T>) => QueryParams);
  body?: unknown | ((exchange: Exchange<T>) => unknown);
  timeoutMs?: number;
  throwOnHttpError?: boolean;
}

export type HttpResult<T = string | unknown> = {
  status: number;
  headers: Record<string, string>;
  body: T;
  url: string;
};

// --------------------------------------------------------------------------
// Source + plugin
// --------------------------------------------------------------------------

/**
 * API-key auth options accepted by the http plugin. Mirrors the validator
 * shape used by `jwt()` / `jwks()` so the plugin's `auth` slot remains a
 * single uniform surface.
 *
 * `keys` is the static-allowlist shortcut: any caller presenting one of the
 * listed keys is admitted with a synthetic `Principal { kind: "custom",
 * scheme: "apiKey", subject: "<key fingerprint>" }`. Use `verify` instead
 * when a key needs to resolve to a per-user identity (database lookup).
 *
 * @experimental
 */
export interface ApiKeyAuthOptions {
  /** Discriminator: this is API-key auth, not bearer. */
  readonly kind: "apiKey";
  /** Where to look for the key. Defaults to `"header"`. */
  in?: "header" | "query";
  /**
   * Header (or query) parameter name. Defaults to `"x-api-key"` for header
   * lookups and `"api_key"` for query lookups.
   */
  name?: string;
  /** Static allowlist of accepted keys. Mutually exclusive with `verify`. */
  keys?: readonly string[];
  /**
   * Custom verifier. Receives the raw key and returns a {@link Principal}
   * (admit) or `null` (reject). Throwing is also a rejection.
   */
  verify?: (key: string) => Principal | null | Promise<Principal | null>;
}

/**
 * Reserved future shape so adding OAuth 2.1 as a follow-up is non-breaking.
 * Today it serves only as a sentinel in the discriminated union.
 *
 * @internal
 */
export interface OAuthAuthOptionsReserved {
  readonly kind: "oauth";
}

/**
 * Auth strategy accepted at the plugin level. Three shapes:
 *
 * - {@link ValidatorAuthOptions} / {@link OAuthValidatorAuthOptions}:
 *   anything that exposes a `validator(token) -> Principal` -- typically the
 *   result of `jwt(...)` or `jwks(...)`. Activated by the presence of
 *   `Authorization: Bearer <token>`.
 * - {@link ApiKeyAuthOptions}: header or query API key. Discriminated by
 *   `kind: "apiKey"`.
 * - {@link OAuthAuthOptionsReserved}: placeholder for the upcoming OAuth
 *   2.1 server flow (`kind: "oauth"`). Not implementable in v1.
 */
export type HttpAuth =
  | ValidatorAuthOptions
  | OAuthValidatorAuthOptions
  | ApiKeyAuthOptions
  | OAuthAuthOptionsReserved;

/** Event toggles for the http plugin. */
export interface HttpPluginEventOptions {
  /**
   * Emit `plugin:http:request:completed` after every response. Built-in
   * endpoints (`/health`, `/ready`, `/openapi.json`) never produce this
   * event regardless of the flag. Defaults to `true`.
   */
  perRequest?: boolean;
}

/**
 * Configuration for `defineConfig({ http: {...} })`. Materialised into a
 * plugin via the registered config applier; users rarely import this type
 * directly.
 *
 * @experimental
 */
export interface HttpPluginOptions {
  /** Port to bind. Required. */
  port: number;
  /** Host to bind. Defaults to `"127.0.0.1"`. Pass `"0.0.0.0"` to expose externally. */
  host?: string;
  /**
   * Global auth strategy. Every incoming request is verified by default
   * (rejection returns 401 before any route runs). Per-route routes can
   * relax this with `http({ auth: "optional" | "skip" })`. Per-route
   * extra constraints (roles, scopes, predicate) come from the existing
   * `.authorize({...})` builder method.
   */
  auth?: HttpAuth;
  /**
   * Maximum request body size in bytes. Requests exceeding this cap return
   * 413 Payload Too Large. Defaults to 10 MB.
   */
  maxBodySize?: number;
  /** Event emission toggles. */
  events?: HttpPluginEventOptions;
  /** Built-in endpoint configuration. See {@link HttpBuiltinsOptions}. */
  builtins?: HttpBuiltinsOptions;
}

/**
 * Configuration for the built-in endpoints (`/health`, `/ready`,
 * `/openapi.json`). Each entry takes the same {@link HttpBuiltinOptions}
 * shape; the meaning of each field varies per endpoint as documented on
 * that interface.
 *
 * @experimental
 */
export interface HttpBuiltinsOptions {
  health?: HttpBuiltinOptions;
  ready?: HttpBuiltinOptions;
  openapi?: HttpBuiltinOptions;
}

/**
 * Uniform config shape for every built-in endpoint. Inspired by Spring
 * Boot Actuator's `management.endpoint.<name>.enabled` plus
 * `management.endpoint.health.show-details`, but compressed to a single
 * boolean for the auth gate.
 *
 * What `requireAuth` controls, per endpoint:
 *
 * | Endpoint | `requireAuth: false` | `requireAuth: true` |
 * | --- | --- | --- |
 * | `/health` | n/a (response is `{ status: "ok" }`, nothing to gate) | n/a |
 * | `/ready` | always `{ status: "ready", routes }` | anon: `{ status: "ready" }`; authed: `{ status: "ready", routes }`. Always 200 (k8s probes keep working). |
 * | `/openapi.json` | doc to anyone | 401 to anon; doc to authed |
 *
 * Defaults differ per endpoint based on security best practice:
 *
 * - `health`:  `{ enabled: true }` (k8s liveness must be open; `requireAuth` is a no-op)
 * - `ready`:   `{ enabled: true, requireAuth: true }` (gates the `routes` count)
 * - `openapi`: `{ enabled: true, requireAuth: false }` (matches the
 *   Stripe / GitHub / Twilio / OpenAI convention of publishing the
 *   schema publicly)
 *
 * `requireAuth` has no effect when no global `auth` is configured: there
 * is nothing to authenticate against, so the response collapses to the
 * `requireAuth: false` shape.
 *
 * @experimental
 */
export interface HttpBuiltinOptions {
  /** Whether the endpoint is reachable. Default: `true`. When `false` the path returns 404. */
  enabled?: boolean;
  /** Whether seeing the endpoint's full response requires authentication. See the table above for per-endpoint behaviour. */
  requireAuth?: boolean;
}

/**
 * Back-compat alias. Older code wrote `CraftConfig["http"]: HttpConfig`
 * where `HttpConfig` was a placeholder `Record<string, unknown>`. The
 * placeholder is gone; `HttpConfig` now resolves to the real plugin
 * options shape so the slot continues to type-check.
 */
export type HttpConfig = HttpPluginOptions;

/** Server-side options accepted by `http({...})` when used with `.from(...)`. */
export interface HttpServerOptions {
  /**
   * Path pattern with `:param` segments. Examples: `"/orders"`,
   * `"/orders/:id"`, `"/tenants/:tenant/users/:user"`. Trailing slashes
   * are normalised away.
   */
  path: string;
  /** HTTP method to accept. Defaults to `"GET"`. */
  method?: HttpMethod;
  /**
   * Per-route auth handling against the plugin's global `auth` strategy.
   * Has no effect when no global `auth` is configured.
   *
   * - `"required"` (default): verify the credential; reject 401 if missing
   *   or invalid; attach the resolved {@link Principal} to the exchange.
   *   This is the secure-by-default tier.
   * - `"optional"`: if a credential is presented, verify it strictly --
   *   admit with principal on success, reject 401 on failure. If no
   *   credential is presented, continue with no principal attached. Use for
   *   public routes that personalise when the caller is signed in (a
   *   homepage that greets logged-in users by name, an API endpoint that
   *   rate-limits anonymous higher than authenticated).
   * - `"skip"`: bypass the middleware entirely -- no verification, no
   *   principal attachment, and no `auth:*` events emitted for this route.
   *   Use for truly anonymous endpoints with no notion of identity (RSS
   *   feeds, OG images, redirect handlers, public docs).
   *
   * Combining `"skip"` with `.authorize({...})` always rejects since no
   * principal will ever be attached. That is intentional: `"skip"` is the
   * documented "no identity" signal and stacking an authorization check on
   * it is a user error.
   */
  auth?: "required" | "optional" | "skip";
}

/**
 * Inbound HTTP message produced by the http source. Reaches the route
 * handler as the `body`. The parsed shape depends on `Content-Type`:
 *
 * - `application/json` -> parsed object.
 * - `text/*` -> string.
 * - `application/x-www-form-urlencoded` -> object built from URLSearchParams.
 * - `multipart/form-data` -> `FormData` (with `File` entries for uploads).
 * - other / no body -> `Uint8Array` (possibly empty).
 *
 * The route is free to swap the body in a `.transform(...)` step; the
 * dispatcher only reads the post-pipeline body for the response.
 *
 * Typed as `unknown` on purpose: the concrete runtime shape is only known
 * from the request's `Content-Type` (parsed object for JSON, `string` for
 * text, plain object for url-encoded form, `FormData` for multipart, or
 * `Uint8Array` for anything else). Route steps narrow it, typically via an
 * `.input()` schema. A union including `unknown` would collapse to `unknown`
 * anyway, so the alias states the honest contract and keeps the per-type
 * mapping in this doc comment.
 */
export type HttpRequestBody = unknown;

/**
 * Hint shape for influencing the response. Populated by writing the matching
 * headers on the exchange somewhere in the pipeline; the dispatcher reads
 * them when building the response object.
 */
export interface HttpResponseHint {
  status?: number;
  contentType?: string;
  headers?: Readonly<Record<string, string>>;
}

// --------------------------------------------------------------------------
// Header keys registry augmentation
// --------------------------------------------------------------------------

// See .standards/type-safety-and-schemas.md#module-augmentation for why this
// targets the package specifier and not a relative path.
declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    /** Request method as received from the client. */
    "routecraft.http.method"?: HttpMethod;
    /** Matched route pattern (e.g. `/orders/:id`). */
    "routecraft.http.path"?: string;
    /** Raw URL the client sent (path + query). */
    "routecraft.http.url"?: string;
    /** Resolved path parameters keyed by name. */
    "routecraft.http.params"?: Readonly<Record<string, string>>;
    /** Query string parameters as a flat object. Repeated keys keep the last value. */
    "routecraft.http.query"?: Readonly<Record<string, string>>;
    /** Request headers as a flat lower-cased object. */
    "routecraft.http.headers"?: Readonly<Record<string, string>>;
    /** Override the response status code. */
    "routecraft.http.response.status"?: number;
    /** Override the response Content-Type. */
    "routecraft.http.response.contentType"?: string;
    /** Extra response headers merged into the final Response. */
    "routecraft.http.response.headers"?: Readonly<Record<string, string>>;
  }
}
