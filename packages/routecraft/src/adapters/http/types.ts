import type { Duration } from "../../shared/duration.ts";
import type { Exchange } from "../../exchange";
import type {
  OAuthValidatorAuthOptions,
  Principal,
  ValidatorAuthOptions,
} from "../../auth/types";
import type { HttpOpenApiInfo } from "../../plugins/http/openapi";
import type {
  HttpWebhookSignatureOptions,
  HttpWebhookSignatureScheme,
} from "../../plugins/http/webhook-signature";

export type {
  HttpOpenApiInfo,
  HttpWebhookSignatureOptions,
  HttpWebhookSignatureScheme,
};

/** HTTP request methods supported by both the destination and the source. */
export type HttpMethod =
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** Query string values accepted by the destination's `query` option. */
export type QueryParams = Record<string, string | number | boolean>;

// --------------------------------------------------------------------------
// Destination (client side). Option type named per the Server/Client
// convention for two-sided adapters.
// --------------------------------------------------------------------------

/**
 * What the client does when the server answers with a 3xx. Mirrors the
 * platform `RequestInit.redirect` values, and nothing more: the option
 * reports what happened and hands control back to the route.
 *
 * - `"follow"` (the default): the runtime follows the chain and the result
 *   describes the final response.
 * - `"manual"`: the 3xx itself is returned, `Location` readable in
 *   {@link HttpResult.headers}, so a route that validated the URL it asked
 *   for can re-run that rule on the next hop instead of having the adapter
 *   walk somewhere the route never approved. Such a 3xx does not trip
 *   `throwOnHttpError`, because it is the outcome the route asked for;
 *   every other non-2xx still does, `304` included, since a cache answer is
 *   not a hop.
 * - `"error"`: the request fails rather than following.
 */
export type HttpRedirectMode = "follow" | "manual" | "error";

export interface HttpClientOptions<T = unknown> {
  method?: HttpMethod;
  url: string | ((exchange: Exchange<T>) => string);
  headers?:
    | Record<string, string>
    | ((exchange: Exchange<T>) => Record<string, string>);
  query?: QueryParams | ((exchange: Exchange<T>) => QueryParams);
  body?: unknown | ((exchange: Exchange<T>) => unknown);
  /** Abandon the request after this long. No deadline when unset. */
  timeout?: Duration;
  throwOnHttpError?: boolean;
  /**
   * Maximum response body size in bytes. Defaults to 10 MB, the same name
   * and the same number as the http plugin's inbound cap, so one concept
   * means one thing on both sides of the framework.
   *
   * A declared `Content-Length` above the cap is refused before a byte is
   * read; otherwise the body streams and is abandoned the moment the count
   * crosses the ceiling, which bounds what an oversized response can cost
   * the process rather than only what it hands the route. Exceeding it
   * fails the exchange with `RC5061`: a truncated body would hand the
   * route half a document and let it parse as though it were whole.
   *
   * `Infinity` is the named way to opt out entirely. Zero and negatives are
   * refused rather than read as "no limit", so an options object built
   * programmatically cannot arrive at unbounded by accident.
   */
  maxBodySize?: number;
  /**
   * What to do with a 3xx response. Defaults to `"follow"`, the platform
   * default and the behaviour of every existing route. See
   * {@link HttpRedirectMode}.
   */
  redirect?: HttpRedirectMode;
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
   * Scopes granted to a caller admitted by the static `keys` allowlist.
   *
   * Every listed key carries the same scopes, because a flat allowlist has
   * no place to hang per-key authority; when different callers need
   * different scopes, `verify` returns a principal per key and this field
   * is not the tool. Without it a static key mints a principal carrying no
   * scopes at all, which any scope check refuses.
   *
   * Refused alongside `verify` with `RC5003` rather than ignored: a verifier
   * returns the principal itself, so the scopes belong on what it returns and
   * a second place to declare them could only disagree with it.
   */
  scopes?: readonly string[];
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
  /**
   * Single-mount shorthand: named entry from `CraftConfig.servers` for the
   * implicit `default` mount at `"/"`. Defaults to `"default"`. Mutually
   * exclusive with `mounts`, where each mount names its own server; the top
   * level of this options object is the mount definition when there is only
   * one, exactly as mcp and ops options are theirs.
   */
  server?: string;
  /**
   * Single-mount shorthand: auth for the implicit `default` mount at `"/"`.
   * Mutually exclusive with `mounts`. The mount is the wall: with a
   * validator in scope every route on it requires a valid credential; the
   * only route-level escalation is `.authorize()`. Omit (with a
   * server-level `servers.<name>.auth`) to inherit the server validator,
   * or pass `false` for a surface with no wall.
   */
  auth?: HttpAuth | false;
  /**
   * Named path-scoped surfaces, each a complete self-description: path,
   * server, auth. Mutually exclusive with the top-level `server` and `auth`
   * shorthand.
   *
   * ```ts
   * http: {
   *   mounts: {
   *     api:     { path: "/api" },           // servers.default, inherits its wall
   *     admin:   { path: "/admin", server: "internal" },
   *     default: { path: "/", auth: false }, // public catch-all
   *   },
   * }
   * ```
   *
   * Routes select a mount with `http({ mount: "api", path: "/orders" })`;
   * an omitted `mount` resolves only to a mount literally named `default`.
   */
  mounts?: Record<string, HttpMountDefinition>;
  /**
   * Maximum request body size in bytes. Requests exceeding this cap return
   * 413 Payload Too Large. Defaults to 10 MB, the same number as the
   * `http()` client's response cap.
   *
   * Must be a positive integer. Unlike the client option of the same name,
   * `Infinity` is refused: an inbound request comes from a stranger and is
   * buffered whole before it can be measured, so an unbounded cap here
   * means one request can exhaust the process, which is what this option
   * exists to prevent.
   */
  maxBodySize?: number;
  /** Event emission toggles. */
  events?: HttpPluginEventOptions;
  /**
   * Built-in endpoint configuration. See {@link HttpBuiltinsOptions}.
   * Built-ins serve from the mount named `default` when its path is `"/"`;
   * with no such mount they are disabled.
   */
  builtins?: HttpBuiltinsOptions;
}

/**
 * One path-scoped surface under {@link HttpPluginOptions.mounts}. Each mount
 * describes itself completely: which listener it sits on and which validator
 * applies. There is no plugin-level default to override.
 *
 * The mount decides authentication for every route on it:
 * - `auth` unset inherits the server validator (`servers.<name>.auth`) as
 *   a wall when one is configured, else the mount is open.
 * - `auth` set is the mount's own wall, replacing the server's validator.
 * - `auth: false` removes the wall: requests are served without credentials
 *   being demanded, and the inherited validator stays reachable, so a route
 *   that declares `.authorize()` still pulls verification through it.
 *   Identity demands can only tighten a public mount, never the reverse.
 */
export interface HttpMountDefinition {
  /** Path prefix this mount owns. `"/"` is the catch-all fallback. */
  path: string;
  /** Named entry from `CraftConfig.servers`. Defaults to `"default"`. */
  server?: string;
  auth?: HttpAuth | false;
}

/**
 * Configuration for the built-in endpoints (`/health`, `/ready`,
 * `/openapi.json`). Each entry takes the {@link HttpBuiltinOptions}
 * shape; openapi additionally accepts an `info` block to populate the
 * OpenAPI document's `info` object. The meaning of `requireAuth` varies
 * per endpoint as documented on {@link HttpBuiltinOptions}.
 *
 * @experimental
 */
export interface HttpBuiltinsOptions {
  health?: HttpBuiltinOptions;
  ready?: HttpBuiltinOptions;
  openapi?: HttpOpenApiBuiltinOptions;
}

/**
 * Configuration for `/openapi.json` specifically. Extends the uniform
 * {@link HttpBuiltinOptions} shape with `info`, the OpenAPI `info` block
 * (`title`, `version`, `description`, `contact`, `license`). When omitted,
 * `title` and `version` auto-detect from the host project's `package.json`;
 * see {@link HttpOpenApiInfo} for the security rationale on which fields
 * are auto-pulled and which are opt-in.
 *
 * @experimental
 */
export interface HttpOpenApiBuiltinOptions extends HttpBuiltinOptions {
  info?: HttpOpenApiInfo;
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
   * Named mount under `http.mounts` this route belongs to. The mount, not
   * the route, decides authentication: a mount with an effective validator
   * is a wall (every route 401s without a valid token), a mount with
   * `auth: false` is public. The one route-level escalation is
   * `.authorize()`, which forces credential verification even on a public
   * mount; there is no route-level way to weaken a mount's posture.
   *
   * `path` is relative to the mount's prefix (a route `"/orders/:id"` on a
   * mount at `"/api"` serves `/api/orders/:id`).
   *
   * When omitted, the route resolves only to a mount literally named
   * `"default"`; if the plugin declares mounts and none is named
   * `default`, omitting `mount` fails loudly at subscribe rather than
   * silently landing a route on the wrong surface.
   */
  mount?: string;
  /**
   * Attach the exact wire bytes of the request body to the exchange as
   * `routecraft.http.rawBody` (a `Uint8Array`). Needed to verify webhook
   * signatures manually: providers sign the raw bytes, and re-serialising
   * the parsed body is not byte-faithful. Defaults to `false`.
   *
   * Opt-in because of retention and exposure, not cost: the bytes already
   * exist in memory during parsing, but attaching them pins a buffer of up
   * to `maxBodySize` for the exchange lifetime and surfaces raw payload
   * bytes to anything that logs or serialises the exchange headers.
   */
  rawBody?: boolean;
  /**
   * Declarative webhook-signature verification. When set, the plugin
   * verifies the raw request bytes against the configured header before
   * any route step runs; a missing, invalid, or expired signature returns
   * 401 and emits `auth:rejected` with `scheme: "signature"`. Independent
   * of the mount's bearer wall; place webhook routes whose only credential
   * is the signature itself on a public mount (`auth: false`).
   *
   * Only valid on body-bearing methods; configuring it on `GET`, `HEAD`,
   * `DELETE`, or `OPTIONS` throws RC5003 at construction. For providers
   * whose scheme is not built in, use `rawBody: true` and verify in a
   * route step instead. See {@link HttpWebhookSignatureOptions}.
   */
  signature?: HttpWebhookSignatureOptions;
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
    /**
     * Raw request headers as a flat lower-cased map. This is the open-ended,
     * pass-through wire-header remainder (mirrors `routecraft.mail.rawHeaders`);
     * the parsed request envelope (method, path, query, params) is promoted to
     * its own keys above.
     */
    "routecraft.http.rawHeaders"?: Readonly<Record<string, string>>;
    /**
     * Exact wire bytes of the request body. Only present when the route
     * opted in via `http({ rawBody: true })`; empty-body requests carry an
     * empty array. Use for manual webhook-signature verification or any
     * consumer that needs byte-faithful input.
     */
    "routecraft.http.rawBody"?: Uint8Array;
    /** Override the response status code. */
    "routecraft.http.response.status"?: number;
    /** Override the response Content-Type. */
    "routecraft.http.response.contentType"?: string;
    /** Extra response headers merged into the final Response. */
    "routecraft.http.response.headers"?: Readonly<Record<string, string>>;
  }
}
