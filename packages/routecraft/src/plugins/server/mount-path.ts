import { rcError } from "../../error";

/**
 * Validate and normalise a static pathname claim: an http mount prefix or the
 * MCP endpoint path.
 *
 * Dispatch compares the request URL's parsed pathname literally against these
 * strings, so a claim the WHATWG parser would rewrite (dot segments raw or
 * encoded, backslashes, spaces, non-ASCII) can never match what the server
 * dispatches on, and percent-encoding makes two spellings of the same
 * resource compare differently. A colon is allowed inside a segment (a legal
 * pathname character the parser preserves) but not at its start, which is the
 * `:param` shape route patterns treat as dynamic. Everything outside the
 * canonical form is refused at construction with RC5003.
 *
 * Normalisation strips exactly one trailing slash (`"/api/"` becomes
 * `"/api"`); repeated trailing slashes are a typo and fall through to the
 * empty-segment rejection instead of being silently collapsed, including the
 * bare `"//"` that would otherwise collapse into the catch-all.
 */
export function normalizeStaticPathPrefix(raw: unknown, owner: string): string {
  const shown = typeof raw === "string" ? JSON.stringify(raw) : String(raw);
  if (typeof raw !== "string" || !raw.startsWith("/")) {
    throw rcError("RC5003", undefined, {
      message: `${owner}: invalid path ${shown}. Pass an absolute prefix such as "/api" (or "/" for the catch-all).`,
    });
  }
  const path = raw.length > 1 ? raw.replace(/\/$/, "") : raw;
  if (
    (path === "/" && raw !== "/") ||
    (path !== "/" &&
      !/^\/(?:[^/?#:\\%][^/?#\\%]*\/)*[^/?#:\\%][^/?#\\%]*$/.test(path))
  ) {
    throw rcError("RC5003", undefined, {
      message: `${owner}: invalid path ${shown}. Paths are static pathname prefixes: no "?", "#", ":param" segments, empty segments, backslashes, or percent-encoding.`,
    });
  }
  if (new URL(path, "http://routecraft.invalid").pathname !== path) {
    throw rcError("RC5003", undefined, {
      message: `${owner}: invalid path ${shown}. Paths must be canonical pathnames: no "." or ".." segments, spaces, or characters the URL parser rewrites.`,
    });
  }
  return path;
}
