import { createHash } from "node:crypto";
import { rcError } from "../../error";
import { markAuthentic } from "../../auth/authentic";
import type { Principal, TokenVerifier } from "../../auth/types";
import type {
  ApiKeyAuthOptions,
  HttpAuth,
  OAuthAuthOptionsReserved,
} from "../../adapters/http/types";

/**
 * Result of running the auth middleware on a request.
 *
 * - `admit` always carries a {@link Principal}: every implemented strategy
 *   (apiKey static / verify, validator bearer) produces one on the admit
 *   path.
 * - `absent` is returned when the request carried no credential at all (no
 *   `Authorization` header for bearer; no header / query parameter for
 *   apiKey). The dispatcher converts this to 401 on `auth: "required"`
 *   routes and lets the request through with no principal on
 *   `auth: "optional"` routes. Carries the `scheme` only; the dispatcher
 *   decides whether to issue a Response based on the route's auth mode.
 * - `reject` is returned when a credential was presented but failed
 *   verification. It carries the canonical 401 response the dispatcher
 *   should return, plus the `reason` and `scheme` that drive the
 *   `auth:rejected` event payload.
 */
export type AuthResult =
  | { kind: "admit"; principal: Principal }
  | { kind: "absent"; scheme: string }
  | { kind: "reject"; response: Response; reason: string; scheme: string };

/** Request-level middleware produced by {@link createAuthMiddleware}. */
export type HttpAuthMiddleware = (req: Request) => Promise<AuthResult>;

/**
 * Build an API-key auth strategy. Use with `http: { auth: apiKey({...}) }`.
 *
 * @example Static allowlist (most common case)
 * ```ts
 * http: { port: 8080, auth: apiKey({ keys: [process.env.API_KEY!] }) }
 * ```
 *
 * @example Database-backed lookup that resolves to a per-user principal
 * ```ts
 * apiKey({
 *   in: "header",
 *   name: "x-api-key",
 *   verify: async (key) => {
 *     const user = await db.users.findByApiKey(key);
 *     if (!user) return null;
 *     return { kind: "custom", scheme: "apiKey", subject: user.id, roles: user.roles };
 *   },
 * })
 * ```
 *
 * @experimental
 */
export function apiKey(
  opts: Omit<ApiKeyAuthOptions, "kind">,
): ApiKeyAuthOptions {
  const hasKeys = Array.isArray(opts.keys) && opts.keys.length > 0;
  if (!hasKeys && !opts.verify) {
    throw rcError("RC5003", undefined, {
      message:
        "apiKey() requires a non-empty `keys` allowlist or a `verify` function.",
    });
  }
  if (hasKeys && opts.verify) {
    throw rcError("RC5003", undefined, {
      message:
        "apiKey() accepts either `keys` or `verify`, not both. Pick the static allowlist (`keys`) or the dynamic verifier (`verify`).",
    });
  }
  if (opts.name !== undefined) {
    if (opts.name.trim() === "") {
      throw rcError("RC5003", undefined, {
        message:
          "apiKey() received an empty `name`. Provide a non-empty header or query parameter name, or omit `name` for the default.",
      });
    }
    // RFC 7230 §3.2.6: header field names must be valid tokens. Validate only
    // when the key is sourced from a header; query parameter names are less
    // restricted and a bad one fails loudly at request time anyway.
    if (
      (opts.in ?? "header") === "header" &&
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(opts.name)
    ) {
      throw rcError("RC5003", undefined, {
        message:
          "apiKey() received an invalid header `name`. Use a valid HTTP header token (RFC 7230 §3.2.6).",
      });
    }
  }
  // Spread first so the `kind` literal always wins over an untyped caller that
  // sneaks a different discriminator through `as any`.
  return { ...opts, kind: "apiKey" };
}

function reject(reason: string, scheme: string): AuthResult {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  // `WWW-Authenticate` advertises a scheme the server actually accepts. Only
  // emit it for the bearer scheme; sending `Bearer` on an api-key rejection
  // mis-signals the protocol (RFC 7235) and confuses auto-refreshing clients.
  if (scheme === "bearer") {
    headers["www-authenticate"] = 'Bearer realm="routecraft"';
  }
  const response = new Response(
    JSON.stringify({ error: "unauthorized", reason }),
    {
      status: 401,
      headers,
    },
  );
  return { kind: "reject", response, reason, scheme };
}

function isApiKeyAuth(auth: HttpAuth): auth is ApiKeyAuthOptions {
  return (auth as { kind?: string }).kind === "apiKey";
}

function isOAuthReserved(auth: HttpAuth): auth is OAuthAuthOptionsReserved {
  return (auth as { kind?: string }).kind === "oauth";
}

function isValidatorAuth(auth: HttpAuth): auth is { validator: TokenVerifier } {
  return (
    typeof (auth as { validator?: unknown }).validator === "function" &&
    !isApiKeyAuth(auth) &&
    !isOAuthReserved(auth)
  );
}

// Default key name differs per location to match each convention: `x-api-key`
// for headers, `api_key` for query strings. Lookups also differ on casing:
// header names are case-insensitive (HTTP), so the header path lowercases;
// query parameter names are case-sensitive (URL spec), so the query path
// matches verbatim. Both behaviours are documented on the adapters reference
// page.
function defaultApiKeyName(where: "header" | "query"): string {
  return where === "header" ? "x-api-key" : "api_key";
}

function syntheticApiKeyPrincipal(key: string): Principal {
  // SHA-256, truncated to 16 hex chars. Stable across processes, collision-safe
  // at any realistic key count, and reveals nothing about the source string
  // regardless of its length. The earlier substring approach leaked short keys
  // verbatim into `subject` (and therefore into logs and `auth:success`
  // payloads), which is exactly what the security standard forbids.
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return {
    kind: "custom",
    scheme: "apiKey",
    subject: `apiKey:${digest}`,
  };
}

/**
 * Build the middleware that runs once per incoming request. Returns
 * `undefined` (callers should treat as "no auth, admit all") when the
 * plugin was configured without an `auth` block.
 *
 * Throws `RC5003` at plugin init when the supplied options are malformed
 * (notably: OAuth reserved sentinel, since OAuth 2.1 is a v2 follow-up).
 */
export function createAuthMiddleware(
  auth: HttpAuth | undefined,
): HttpAuthMiddleware | undefined {
  if (auth === undefined) return undefined;

  if (isOAuthReserved(auth)) {
    throw rcError("RC5003", undefined, {
      message:
        "OAuth 2.1 auth is reserved on the http plugin but not implemented in this release. Use jwt(...) / jwks(...) for bearer auth, or apiKey(...) for API-key auth.",
    });
  }

  if (isApiKeyAuth(auth)) {
    const where = auth.in ?? "header";
    const name = auth.name ?? defaultApiKeyName(where);
    const lowerName = name.toLowerCase();
    const allowedSet =
      auth.keys && auth.keys.length > 0 ? new Set(auth.keys) : undefined;
    const verify = auth.verify;

    // The factory guarantees exactly one of `allowedSet` / `verify` is set;
    // assert here so a future bug in the factory surfaces as RC5003 instead
    // of a silent 401.
    if (!allowedSet && !verify) {
      throw rcError("RC5003", undefined, {
        message:
          "apiKey middleware reached construction with neither `keys` nor `verify`. Check the apiKey() factory.",
      });
    }

    return async (req: Request): Promise<AuthResult> => {
      let raw: string | null = null;
      if (where === "header") {
        raw = req.headers.get(lowerName);
      } else {
        try {
          raw = new URL(req.url).searchParams.get(name);
        } catch {
          raw = null;
        }
      }
      if (!raw) {
        return { kind: "absent", scheme: "apiKey" };
      }
      if (allowedSet) {
        if (!allowedSet.has(raw)) {
          return reject("invalid api key", "apiKey");
        }
        return {
          kind: "admit",
          principal: markAuthentic(syntheticApiKeyPrincipal(raw)),
        };
      }
      try {
        const principal = await verify!(raw);
        if (!principal) {
          return reject("invalid api key", "apiKey");
        }
        return { kind: "admit", principal: markAuthentic(principal) };
      } catch {
        return reject("invalid api key", "apiKey");
      }
    };
  }

  if (isValidatorAuth(auth)) {
    const validator = auth.validator;
    return async (req: Request): Promise<AuthResult> => {
      const header = req.headers.get("authorization");
      if (!header || !header.toLowerCase().startsWith("bearer ")) {
        return { kind: "absent", scheme: "bearer" };
      }
      const token = header.slice(7).trim();
      if (!token) {
        return { kind: "absent", scheme: "bearer" };
      }
      try {
        const principal = await validator(token);
        if (!principal) {
          return reject("invalid token", "bearer");
        }
        return { kind: "admit", principal: markAuthentic(principal) };
      } catch {
        return reject("invalid token", "bearer");
      }
    };
  }

  throw rcError("RC5003", undefined, {
    message:
      "http plugin: unsupported auth shape. Pass jwt(...) / jwks(...), apiKey({...}), or { validator: (token) => Principal }.",
  });
}
