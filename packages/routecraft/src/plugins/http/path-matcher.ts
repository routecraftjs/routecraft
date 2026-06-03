/**
 * Compile a path pattern into a matcher closure.
 *
 * Supports literal segments and `:param` segments. Pattern and pathname are
 * tokenised on `/`; an empty leading token (from the leading `/`) and any
 * empty trailing token (from a trailing `/`) are dropped so `"/orders"`,
 * `"/orders/"`, and the pathname `"/orders/"` all behave the same way.
 *
 * URL-decoding happens once per matched segment so handlers receive the
 * decoded value (`"hello world"`, not `"hello%20world"`).
 *
 * URLPattern would do all of this, but it is not a global in Node 22. Doing
 * it by hand keeps the http source dependency-free; richer patterns
 * (constraints, wildcards) can move to URLPattern when the minimum Node
 * version catches up.
 */

export interface PathMatcher {
  /** Try to match a concrete pathname. Returns the resolved params on success, null on miss. */
  match(pathname: string): Readonly<Record<string, string>> | null;
  /** Original pattern, e.g. `/orders/:id`. */
  readonly pattern: string;
  /** Names of `:param` segments in the pattern, in declaration order. */
  readonly paramNames: readonly string[];
}

interface CompiledSegment {
  readonly literal: string | null;
  readonly param: string | null;
}

function tokenise(value: string): string[] {
  const stripped = value.replace(/\/+$/, "");
  if (stripped === "" || stripped === "/") return [];
  return stripped.split("/").filter((s) => s !== "");
}

function compileSegment(segment: string, pattern: string): CompiledSegment {
  if (segment.startsWith(":")) {
    const name = segment.slice(1);
    if (name === "") {
      throw new Error(
        `compilePathMatcher: empty parameter name in pattern "${pattern}"`,
      );
    }
    return { literal: null, param: name };
  }
  return { literal: segment, param: null };
}

/**
 * Compile a pattern string into a {@link PathMatcher}. Throws on malformed
 * patterns (empty `:` parameter names) so misconfiguration fails at startup
 * rather than per request.
 */
export function compilePathMatcher(pattern: string): PathMatcher {
  const segments = tokenise(pattern).map((seg) => compileSegment(seg, pattern));
  const paramNames = segments
    .map((s) => s.param)
    .filter((p): p is string => p !== null);

  return {
    pattern,
    paramNames,
    match(pathname: string): Readonly<Record<string, string>> | null {
      const tokens = tokenise(pathname);
      if (tokens.length !== segments.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        const token = tokens[i]!;
        if (seg.literal !== null) {
          if (seg.literal !== token) return null;
          continue;
        }
        if (seg.param !== null) {
          try {
            params[seg.param] = decodeURIComponent(token);
          } catch {
            // Malformed percent-encoding: treat as a non-match rather than
            // surfacing a decode error to the client.
            return null;
          }
        }
      }
      return Object.freeze(params);
    },
  };
}
