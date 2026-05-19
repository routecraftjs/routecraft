import { describe, test, expect } from "bun:test";
import {
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
     * @case origin: "*" produces a permissive policy and is incompatible with credentials
     * @preconditions origin: "*", credentials true vs false
     * @expectedResult origin:"*" works without credentials; combining with credentials throws TypeError
     */
    test("origin: '*' is permissive but rejects credentials", () => {
      const resolved = resolveCorsOptions({ origin: "*" });
      expect(resolved).not.toBeNull();
      expect(resolved!.isWildcard).toBe(true);
      expect(resolved!.resolveOrigin("https://anywhere.example")).toBe("*");

      expect(() =>
        resolveCorsOptions({ origin: "*", credentials: true }),
      ).toThrow(/cors\.credentials.*cors\.origin is '\*'/i);
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

    /**
     * @case Custom exposeHeaders are additive with the WWW-Authenticate default
     * @preconditions exposeHeaders: ["X-Custom", "X-Request-Id"]
     * @expectedResult Resolved exposeHeaders includes WWW-Authenticate plus the user values, case-insensitive dedupe
     */
    test("exposeHeaders is additive with the WWW-Authenticate default", () => {
      const resolved = resolveCorsOptions({
        exposeHeaders: ["X-Custom", "www-authenticate", "X-Request-Id"],
      });
      const list = resolved!.exposeHeaders.split(", ");
      expect(list).toContain("WWW-Authenticate");
      expect(list).toContain("X-Custom");
      expect(list).toContain("X-Request-Id");
      // Case-insensitive dedupe: user passed "www-authenticate" lowercase but
      // the default WWW-Authenticate is kept and the duplicate dropped.
      expect(
        list.filter((h) => h.toLowerCase() === "www-authenticate").length,
      ).toBe(1);
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
     * @case Non-allowed origins produce no Access-Control-* headers
     * @preconditions Default (loopback-only) policy; Origin is a public domain
     * @expectedResult Empty object; browser will block the response
     */
    test("rejects non-loopback origins under the default policy", () => {
      const cors = resolveCorsOptions(undefined);
      expect(buildCorsHeaders(cors, "https://evil.example", false)).toEqual({});
      expect(buildCorsHeaders(cors, "https://evil.example", true)).toEqual({});
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
     * @case Preflight responses include Access-Control-Allow-Methods/Headers and optional Max-Age
     * @preconditions Default policy + maxAge: 600; preflight=true; loopback Origin
     * @expectedResult Methods, Headers, and Max-Age fields present in the response
     */
    test("preflight emits methods, headers, and max-age", () => {
      const cors = resolveCorsOptions({ maxAge: 600 });
      const headers = buildCorsHeaders(cors, "http://localhost:6274", true);
      expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
      expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
      expect(headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
      expect(headers["Access-Control-Allow-Headers"]).toBe("*");
      expect(headers["Access-Control-Max-Age"]).toBe("600");
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
      expect(headers["Access-Control-Max-Age"]).toBeUndefined();
    });

    /**
     * @case Credentials flag with explicit origin emits Allow-Credentials: true
     * @preconditions origin: "https://app.example.com"; credentials: true
     * @expectedResult Access-Control-Allow-Credentials: true on a matching origin
     */
    test("credentials flag emits Allow-Credentials with explicit origin", () => {
      const cors = resolveCorsOptions({
        origin: "https://app.example.com",
        credentials: true,
      });
      const headers = buildCorsHeaders(cors, "https://app.example.com", false);
      expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    });
  });
});
