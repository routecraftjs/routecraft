import type { HttpMount } from "./types.ts";

/** Parse an HTTP authority without accepting URL paths, userinfo or escapes. */
function hostnameOf(authority: string): string | undefined {
  if (
    !/^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9._-]+)(?::[0-9]{1,5})?$/.test(authority)
  ) {
    return undefined;
  }
  try {
    return new URL(`http://${authority}`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

/** Validate and snapshot explicitly trusted hostnames at construction. */
export function resolveAllowedHostnames(
  input: readonly string[] | undefined,
): ReadonlySet<string> {
  if (input !== undefined && !Array.isArray(input)) {
    throw new TypeError("allowedHostnames must be an array of hostnames");
  }
  return new Set(
    (input ?? []).map((name) => {
      if (typeof name !== "string") {
        throw new TypeError(
          "allowedHostnames entries must be hostnames without a scheme, path or port",
        );
      }
      const authority =
        name.includes(":") && !name.startsWith("[") ? `[${name}]` : name;
      const hostname = hostnameOf(authority);
      if (
        hostname === undefined ||
        (!authority.endsWith("]") && authority.includes(":"))
      ) {
        throw new TypeError(
          "allowedHostnames entries must be hostnames without a scheme, path or port",
        );
      }
      return hostname;
    }),
  );
}

/** Only serialized HTTP(S) origins are browser-admission identities. */
function isBrowserOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

export interface ResolvedRequestValidation {
  readonly allowedHostnames: ReadonlySet<string>;
  readonly browserOrigins: ReadonlySet<string>;
}

/** Browser access is denied unless a mount explicitly names the origins. */
export function resolveRequestValidation(
  options: NonNullable<HttpMount["requestValidation"]>,
): ResolvedRequestValidation {
  if (
    options.browserOrigins !== undefined &&
    !Array.isArray(options.browserOrigins)
  ) {
    throw new TypeError("browserOrigins must be an array of HTTP(S) origins");
  }
  const origins = options.browserOrigins ?? [];
  for (const origin of origins) {
    if (typeof origin !== "string" || !isBrowserOrigin(origin)) {
      throw new TypeError(
        "browserOrigins entries must be exact HTTP(S) origins without a path, wildcard or credentials",
      );
    }
  }
  return {
    allowedHostnames: resolveAllowedHostnames(options.allowedHostnames),
    browserOrigins: new Set(origins),
  };
}

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
const LOCAL_BINDS = new Set([...LOOPBACK, "0.0.0.0", "[::]"]);

/**
 * One protocol ingress gate, independent of CORS and authentication.
 * Forwarding headers and the request URL never contribute trusted names.
 */
export function requestValidationFailure(
  request: Request,
  boundHost: string | undefined,
  serverHostnames: ReadonlySet<string>,
  policy: ResolvedRequestValidation,
): "host" | "origin" | undefined {
  const host = hostnameOf(request.headers.get("host") ?? "");
  const bound =
    boundHost === undefined
      ? undefined
      : hostnameOf(
          boundHost.includes(":") && !boundHost.startsWith("[")
            ? `[${boundHost}]`
            : boundHost,
        );
  if (
    host === undefined ||
    !(
      host === bound ||
      serverHostnames.has(host) ||
      policy.allowedHostnames.has(host) ||
      (bound !== undefined && LOCAL_BINDS.has(bound) && LOOPBACK.includes(host))
    )
  )
    return "host";

  const origin = request.headers.get("origin");
  if (
    origin !== null &&
    (!isBrowserOrigin(origin) || !policy.browserOrigins.has(origin))
  ) {
    return "origin";
  }
  return undefined;
}
