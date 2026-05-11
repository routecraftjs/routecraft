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
// Destination (existing -- unchanged signature). Kept identical so any
// existing user code typed against `HttpOptions<T>` and `HttpResult<R>`
// continues to compile.
// --------------------------------------------------------------------------

export interface HttpOptions<T = unknown> {
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
   * Global auth strategy. Every incoming request is verified; rejection
   * returns 401/403 before any route runs. Per-route routes can opt out
   * with `http({ public: true })`. Per-route extra constraints come from
   * the existing `.authorize({...})` builder method.
   */
  auth?: HttpAuth;
  /**
   * Maximum request body size in bytes. Requests exceeding this cap return
   * 413 Payload Too Large. Defaults to 10 MB.
   */
  maxBodySize?: number;
  /** Event emission toggles. */
  events?: HttpPluginEventOptions;
}

/**
 * Back-compat alias. Older code wrote `CraftConfig["http"]: HttpConfig`
 * where `HttpConfig` was a placeholder `Record<string, unknown>`. The
 * placeholder is gone; `HttpConfig` now resolves to the real plugin
 * options shape so the slot continues to type-check.
 */
export type HttpConfig = HttpPluginOptions;

/** Source-side options accepted by `http({...})` when used with `.from(...)`. */
export interface HttpSourceOptions {
  /**
   * Path pattern with `:param` segments. Examples: `"/orders"`,
   * `"/orders/:id"`, `"/tenants/:tenant/users/:user"`. Trailing slashes
   * are normalised away.
   */
  path: string;
  /** HTTP method to accept. Defaults to `"GET"`. */
  method?: HttpMethod;
  /**
   * Opt the route out of the plugin's global auth check. The dispatcher
   * skips both the `auth:` middleware AND principal attachment, so a
   * `public: true` route paired with `.authorize({...})` will always
   * reject (no principal on the exchange). Default `false`.
   */
  public?: boolean;
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
 */
export type HttpRequestBody =
  | unknown // application/json
  | string
  | URLSearchParams
  | FormData
  | Uint8Array;

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
