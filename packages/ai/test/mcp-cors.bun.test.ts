import { describe, test, expect } from "bun:test";
import {
  applyCorsHeaders,
  buildCorsHeaders,
  defaultLoopbackOriginResolver,
  resolveCorsOptions,
} from "../src/mcp/cors.ts";

describe("MCP CORS helper", () => {
  describe("defaultLoopbackOriginResolver", () => {
    /**
     * @case Loopback hostnames are reflected; non-loopback returns false
     * @preconditions Origin values for localhost, 127.0.0.1, [::1], and a public host
     * @expectedResult Loopback origins echo back; public hostnames return false
     */
    test("reflects loopback origins and rejects non-loopback", () => {
      expect(defaultLoopbackOriginResolver("http://localhost:6274")).toBe(
        "http://localhost:6274",
      );
      expect(defaultLoopbackOriginResolver("http://127.0.0.1:3000")).toBe(
        "http://127.0.0.1:3000",
      );
      expect(defaultLoopbackOriginResolver("http://[::1]:8080")).toBe(
        "http://[::1]:8080",
      );
      expect(defaultLoopbackOriginResolver("https://localhost")).toBe(
        "https://localhost",
      );
      expect(defaultLoopbackOriginResolver("https://app.example.com")).toBe(
        false,
      );
      expect(defaultLoopbackOriginResolver("https://evil.example")).toBe(false);
      expect(defaultLoopbackOriginResolver(undefined)).toBe(false);
      expect(defaultLoopbackOriginResolver("")).toBe(false);
    });

    /**
     * @case Non-http/https protocols are rejected even on loopback
     * @preconditions `file://`, `chrome-extension://`, and malformed Origin values
     * @expectedResult Resolver returns false; only http(s) loopback is accepted
     */
    test("rejects non-http(s) protocols and malformed origins", () => {
      expect(defaultLoopbackOriginResolver("file:///etc/passwd")).toBe(false);
      expect(
        defaultLoopbackOriginResolver("chrome-extension://abcdef/index.html"),
      ).toBe(false);
      expect(defaultLoopbackOriginResolver("not a url")).toBe(false);
    });

    /**
     * @case Non-canonical Origin shapes are rejected even when the host is loopback
     * @preconditions Origin values with path, userinfo, query, or fragment components
     * @expectedResult Resolver returns false; only canonical `scheme://host[:port]` Origins are accepted
     */
    test("rejects non-canonical Origin shapes (path, userinfo, query, fragment)", () => {
      // Path appended -- RFC 6454 §7.1 says Origin has no path component
      expect(
        defaultLoopbackOriginResolver("http://localhost:3000/anything"),
      ).toBe(false);
      // Userinfo -- never present on a legitimate Origin
      expect(
        defaultLoopbackOriginResolver("http://user:pass@localhost:3000"),
      ).toBe(false);
      // Query and fragment -- never on a canonical Origin
      expect(defaultLoopbackOriginResolver("http://localhost:3000?x=1")).toBe(
        false,
      );
      expect(defaultLoopbackOriginResolver("http://localhost:3000#frag")).toBe(
        false,
      );
    });

    /**
     * @case The literal string "null" Origin (sandboxed iframes, srcdoc) is rejected
     * @preconditions Origin: "null"
     * @expectedResult Resolver returns false; the literal "null" is treated as a sentinel, not parsed as a URL
     */
    test("rejects literal 'null' Origin", () => {
      expect(defaultLoopbackOriginResolver("null")).toBe(false);
    });
  });

  describe("resolveCorsOptions", () => {
    /**
     * @case `false` disables CORS entirely
     * @preconditions input is `false`
     * @expectedResult resolveCorsOptions returns null; buildCorsHeaders is a no-op
     */
    test("input false returns null (CORS disabled)", () => {
      expect(resolveCorsOptions(false)).toBeNull();
    });

    /**
     * @case undefined input applies the secure loopback default
     * @preconditions input is undefined
     * @expectedResult Resolved policy uses defaultLoopbackOriginResolver; non-loopback is rejected
     */
    test("undefined input applies the loopback default", () => {
      const resolved = resolveCorsOptions(undefined);
      expect(resolved).not.toBeNull();
      expect(resolved!.resolveOrigin("http://localhost:6274")).toBe(
        "http://localhost:6274",
      );
      expect(resolved!.resolveOrigin("https://evil.example")).toBe(false);
    });

    /**
     * @case origin: "*" produces a permissive policy
     * @preconditions origin: "*"; any request Origin
     * @expectedResult Resolved policy is wildcard; resolver returns "*" for every input
     */
    test("origin: '*' is permissive", () => {
      const resolved = resolveCorsOptions({ origin: "*" });
      expect(resolved).not.toBeNull();
      expect(resolved!.isWildcard).toBe(true);
      expect(resolved!.resolveOrigin("https://anywhere.example")).toBe("*");
    });

    /**
     * @case String origin acts as an exact-match allowlist
     * @preconditions origin: "https://app.example.com"
     * @expectedResult Matches the configured value, rejects others
     */
    test("string origin matches exactly", () => {
      const resolved = resolveCorsOptions({
        origin: "https://app.example.com",
      });
      expect(resolved!.resolveOrigin("https://app.example.com")).toBe(
        "https://app.example.com",
      );
      expect(resolved!.resolveOrigin("https://evil.example")).toBe(false);
      expect(resolved!.resolveOrigin(undefined)).toBe(false);
    });

    /**
     * @case Array origin acts as a multi-origin allowlist
     * @preconditions origin: ["https://a.example", "https://b.example"]
     * @expectedResult Either match reflects; others reject
     */
    test("array origin matches any entry in the allowlist", () => {
      const resolved = resolveCorsOptions({
        origin: ["https://a.example", "https://b.example"],
      });
      expect(resolved!.resolveOrigin("https://a.example")).toBe(
        "https://a.example",
      );
      expect(resolved!.resolveOrigin("https://b.example")).toBe(
        "https://b.example",
      );
      expect(resolved!.resolveOrigin("https://c.example")).toBe(false);
    });

    /**
     * @case Function origin is passed through as the resolver
     * @preconditions origin: custom callback that allows only ".trusted.example"
     * @expectedResult Resolver runs verbatim; outputs are used directly
     */
    test("function origin is invoked directly", () => {
      const resolved = resolveCorsOptions({
        origin: (req) =>
          req !== undefined && req.endsWith(".trusted.example") ? req : false,
      });
      expect(resolved!.resolveOrigin("https://app.trusted.example")).toBe(
        "https://app.trusted.example",
      );
      expect(resolved!.resolveOrigin("https://app.evil.example")).toBe(false);
    });

    /**
     * @case Invalid origin shapes are rejected at construction
     * @preconditions origin is a number, object, or null
     * @expectedResult resolveCorsOptions throws TypeError
     */
    test("invalid origin shapes throw", () => {
      expect(() =>
        resolveCorsOptions({ origin: 42 as unknown as string }),
      ).toThrow(TypeError);
    });
  });

  describe("buildCorsHeaders", () => {
    /**
     * @case Disabled CORS produces no headers
     * @preconditions resolveCorsOptions(false)
     * @expectedResult buildCorsHeaders returns an empty object regardless of request Origin
     */
    test("returns no headers when CORS is disabled", () => {
      expect(buildCorsHeaders(null, "http://localhost:6274", false)).toEqual(
        {},
      );
      expect(buildCorsHeaders(null, undefined, true)).toEqual({});
    });

    /**
     * @case Non-allowed origins produce no Access-Control-* but still emit Vary: Origin
     * @preconditions Default (loopback-only) policy; Origin is a public domain
     * @expectedResult Vary: Origin present so shared caches do not serve a no-CORS variant to a loopback origin; no Access-Control-Allow-Origin
     */
    test("rejects non-loopback origins but still emits Vary: Origin", () => {
      const cors = resolveCorsOptions(undefined);
      const nonPreflight = buildCorsHeaders(
        cors,
        "https://evil.example",
        false,
      );
      expect(nonPreflight).toEqual({ Vary: "Origin" });
      const preflight = buildCorsHeaders(cors, "https://evil.example", true);
      expect(preflight).toEqual({ Vary: "Origin" });
    });

    /**
     * @case Loopback origin gets reflected with Vary: Origin
     * @preconditions Default policy; Origin is http://localhost:6274
     * @expectedResult Access-Control-Allow-Origin echoes the request Origin; Vary: Origin set; WWW-Authenticate exposed
     */
    test("reflects loopback origin with Vary: Origin and exposed WWW-Authenticate", () => {
      const cors = resolveCorsOptions(undefined);
      const headers = buildCorsHeaders(cors, "http://localhost:6274", false);
      expect(headers["Access-Control-Allow-Origin"]).toBe(
        "http://localhost:6274",
      );
      expect(headers["Vary"]).toBe("Origin");
      expect(headers["Access-Control-Expose-Headers"]).toBe("WWW-Authenticate");
    });

    /**
     * @case Wildcard origin omits Vary: Origin
     * @preconditions origin: "*"; any request Origin
     * @expectedResult Access-Control-Allow-Origin: *; Vary: Origin NOT set (cache-friendly)
     */
    test("wildcard origin does not emit Vary: Origin", () => {
      const cors = resolveCorsOptions({ origin: "*" });
      const headers = buildCorsHeaders(cors, "https://anywhere.example", false);
      expect(headers["Access-Control-Allow-Origin"]).toBe("*");
      expect(headers["Vary"]).toBeUndefined();
    });

    /**
     * @case Preflight responses include Access-Control-Allow-Methods and Allow-Headers
     * @preconditions Default policy; preflight=true; loopback Origin
     * @expectedResult Methods header lists GET, POST, OPTIONS; Headers is "*"
     */
    test("preflight emits methods and headers", () => {
      const cors = resolveCorsOptions(undefined);
      const headers = buildCorsHeaders(cors, "http://localhost:6274", true);
      expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
      expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
      expect(headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
      expect(headers["Access-Control-Allow-Headers"]).toBe("*");
    });

    /**
     * @case Non-preflight responses omit Allow-Methods/Allow-Headers
     * @preconditions Default policy; preflight=false; loopback Origin
     * @expectedResult Only Allow-Origin / Vary / Expose-Headers are set on the response
     */
    test("non-preflight responses omit preflight-specific headers", () => {
      const cors = resolveCorsOptions(undefined);
      const headers = buildCorsHeaders(cors, "http://localhost:6274", false);
      expect(headers["Access-Control-Allow-Methods"]).toBeUndefined();
      expect(headers["Access-Control-Allow-Headers"]).toBeUndefined();
    });

    /**
     * @case A throwing user resolver fails closed rather than crashing the request
     * @preconditions origin: () => { throw new Error("boom") }; any request Origin
     * @expectedResult buildCorsHeaders treats the throw as "disallowed", returning only Vary: Origin -- no Allow-Origin
     */
    test("origin resolver that throws fails closed (returns Vary only)", () => {
      const cors = resolveCorsOptions({
        origin: () => {
          throw new Error("boom");
        },
      });
      const headers = buildCorsHeaders(cors, "http://localhost:6274", false);
      expect(headers).toEqual({ Vary: "Origin" });
    });
  });

  describe("applyCorsHeaders", () => {
    /**
     * Minimal fake of a Node ServerResponse that records setHeader/appendHeader calls.
     */
    function fakeRes(initial: Record<string, string | string[]> = {}) {
      const single: Record<string, string> = {};
      const lists: Record<string, string[]> = { ...initial };
      for (const [k, v] of Object.entries(initial)) {
        if (typeof v === "string") {
          lists[k.toLowerCase()] = [v];
        } else {
          lists[k.toLowerCase()] = [...v];
        }
      }
      return {
        setHeader: (name: string, value: string) => {
          single[name] = value;
          lists[name.toLowerCase()] = [value];
        },
        appendHeader: (name: string, value: string) => {
          const key = name.toLowerCase();
          if (!lists[key]) lists[key] = [];
          lists[key].push(value);
        },
        single,
        lists,
      };
    }

    /**
     * @case applyCorsHeaders appends Vary so a pre-existing Vary value is preserved
     * @preconditions Response already has `Vary: Accept-Encoding` from compression middleware; loopback request
     * @expectedResult Both `Accept-Encoding` and `Origin` are present as Vary values; setHeader does not clobber the prior value
     */
    test("appendHeader preserves an existing Vary value", () => {
      const cors = resolveCorsOptions(undefined);
      const res = fakeRes({ Vary: "Accept-Encoding" });
      applyCorsHeaders(
        res as unknown as Parameters<typeof applyCorsHeaders>[0],
        cors,
        "http://localhost:6274",
        false,
      );
      const vary = res.lists["vary"];
      expect(vary).toBeDefined();
      expect(vary).toContain("Accept-Encoding");
      expect(vary).toContain("Origin");
      expect(res.single["Access-Control-Allow-Origin"]).toBe(
        "http://localhost:6274",
      );
    });

    /**
     * @case applyCorsHeaders is a no-op when CORS is disabled
     * @preconditions resolveCorsOptions(false); any request Origin
     * @expectedResult No setHeader or appendHeader calls leave traces on the response
     */
    test("no-op when CORS is disabled", () => {
      const res = fakeRes();
      applyCorsHeaders(
        res as unknown as Parameters<typeof applyCorsHeaders>[0],
        null,
        "http://localhost:6274",
        false,
      );
      expect(Object.keys(res.single)).toEqual([]);
      expect(Object.keys(res.lists)).toEqual([]);
    });

    /**
     * @case applyCorsHeaders still appends Vary when the request Origin is rejected (loopback default)
     * @preconditions Default policy; non-loopback Origin
     * @expectedResult Vary: Origin is appended; no Access-Control-Allow-Origin set
     */
    test("rejected origin still appends Vary: Origin", () => {
      const cors = resolveCorsOptions(undefined);
      const res = fakeRes();
      applyCorsHeaders(
        res as unknown as Parameters<typeof applyCorsHeaders>[0],
        cors,
        "https://evil.example",
        false,
      );
      expect(res.lists["vary"]).toEqual(["Origin"]);
      expect(res.single["Access-Control-Allow-Origin"]).toBeUndefined();
    });
  });
});
