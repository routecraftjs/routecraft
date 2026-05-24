import { rcError } from "../../error";
import type { Principal, TokenVerifier } from "../../auth/types";
import type {
  ApiKeyAuthOptions,
  HttpAuth,
  OAuthAuthOptionsReserved,
} from "../../adapters/http/types";

/**
 * Result of running the auth middleware on a request.
 *
 * `admit` carries an optional principal (the global `none` strategy admits
 * without one). `reject` carries the canonical 401/403 response the
 * dispatcher should return without invoking a route, plus the `reason` and
 * `scheme` that drive the `auth:rejected` event payload.
 */
export type AuthResult =
  | { kind: "admit"; principal: Principal | undefined }
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
  if (!opts.keys && !opts.verify) {
    throw rcError("RC5003", undefined, {
      message:
        "apiKey() requires either `keys` (static allowlist) or `verify` (custom function).",
    });
  }
  if (opts.keys && opts.verify) {
    throw rcError("RC5003", undefined, {
      message:
        "apiKey() accepts either `keys` or `verify`, not both. Pick the static allowlist (`keys`) or the dynamic verifier (`verify`).",
    });
  }
  return { kind: "apiKey", ...opts };
}

function reject(reason: string, scheme: string): AuthResult {
  const response = new Response(
    JSON.stringify({ error: "unauthorized", reason }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="routecraft"',
      },
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
  // Use the first 8 chars as a stable, non-revealing subject. Full keys
  // never reach a principal so logs/events never echo back the secret.
  const fingerprint = `${key.slice(0, 4)}...${key.slice(-4)}`;
  return {
    kind: "custom",
    scheme: "apiKey",
    subject: `apiKey:${fingerprint}`,
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
        return reject("missing api key", "apiKey");
      }
      if (allowedSet) {
        if (!allowedSet.has(raw)) {
          return reject("invalid api key", "apiKey");
        }
        return { kind: "admit", principal: syntheticApiKeyPrincipal(raw) };
      }
      // verify branch -- guarded by apiKey() to be defined when keys is absent.
      try {
        const principal = await verify!(raw);
        if (!principal) {
          return reject("invalid api key", "apiKey");
        }
        return { kind: "admit", principal };
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
        return reject("missing bearer token", "bearer");
      }
      const token = header.slice(7).trim();
      if (!token) {
        return reject("missing bearer token", "bearer");
      }
      try {
        const principal = await validator(token);
        return { kind: "admit", principal };
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
