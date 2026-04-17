import { describe, test, expect } from "vitest";
import { createHmac } from "node:crypto";
import { jwt } from "../src/mcp/jwt.ts";
import type { JwtPrincipal } from "../src/mcp/types.ts";

/**
 * Sign a JWT with HS256 using the test secret. Returns the full compact
 * token. Used by every test in this file to avoid pulling in a JWT library.
 */
function signHs256(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

const SECRET = "test-secret-for-hs256-at-least-32-bytes-long";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

describe("jwt()", () => {
  describe("issuer validation", () => {
    /**
     * @case Token with matching iss is accepted when issuer is set as a string
     * @preconditions jwt() configured with issuer: "https://idp.example.com"; token carries iss: "https://idp.example.com"
     * @expectedResult Validator returns a JwtPrincipal with subject from sub
     */
    test("accepts matching iss when issuer is a single string", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: "https://idp.example.com",
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: "https://idp.example.com",
          exp: FUTURE,
        },
        SECRET,
      );
      const result = (await validator!(token)) as JwtPrincipal;
      expect(result).not.toBeNull();
      expect(result.subject).toBe("user-1");
      expect(result.issuer).toBe("https://idp.example.com");
    });

    /**
     * @case Token with iss matching any entry in array is accepted
     * @preconditions jwt() configured with issuer: ["a", "b"]; token carries iss: "b"
     * @expectedResult Validator returns a JwtPrincipal
     */
    test("accepts iss matching any entry in issuer array", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ["https://a.example.com", "https://b.example.com"],
      });
      const token = signHs256(
        { sub: "user-1", iss: "https://b.example.com", exp: FUTURE },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).not.toBeNull();
    });

    /**
     * @case Token with non-matching iss is rejected
     * @preconditions jwt() configured with issuer: "https://idp.example.com"; token carries iss: "https://evil.example.com"
     * @expectedResult Validator returns null
     */
    test("rejects non-matching iss", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: "https://idp.example.com",
      });
      const token = signHs256(
        { sub: "user-1", iss: "https://evil.example.com", exp: FUTURE },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).toBeNull();
    });

    /**
     * @case Token with missing iss is rejected when issuer is required
     * @preconditions jwt() configured with issuer set; token omits iss
     * @expectedResult Validator returns null
     */
    test("rejects missing iss when issuer is set", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: "https://idp.example.com",
      });
      const token = signHs256({ sub: "user-1", exp: FUTURE }, SECRET);
      const result = await validator!(token);
      expect(result).toBeNull();
    });
  });

  describe("audience validation", () => {
    /**
     * @case Token with string aud matching is accepted when audience is a single string
     * @preconditions jwt() configured with audience: "https://mcp.example.com"; token aud is the same string
     * @expectedResult Validator returns a JwtPrincipal with audience populated
     */
    test("accepts string aud matching single audience", async () => {
      const { validator } = jwt({
        secret: SECRET,
        audience: "https://mcp.example.com",
      });
      const token = signHs256(
        { sub: "user-1", aud: "https://mcp.example.com", exp: FUTURE },
        SECRET,
      );
      const result = (await validator!(token)) as JwtPrincipal;
      expect(result).not.toBeNull();
      expect(result.audience).toEqual(["https://mcp.example.com"]);
    });

    /**
     * @case Token with array aud containing the expected audience is accepted
     * @preconditions jwt() configured with audience: "https://mcp.example.com"; token aud is ["other", "https://mcp.example.com"]
     * @expectedResult Validator returns a JwtPrincipal
     */
    test("accepts array aud containing expected audience", async () => {
      const { validator } = jwt({
        secret: SECRET,
        audience: "https://mcp.example.com",
      });
      const token = signHs256(
        {
          sub: "user-1",
          aud: ["https://other.example.com", "https://mcp.example.com"],
          exp: FUTURE,
        },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).not.toBeNull();
    });

    /**
     * @case Token with aud matching any entry when audience is an array
     * @preconditions jwt() configured with audience: ["a", "b"]; token aud is "b"
     * @expectedResult Validator returns a JwtPrincipal
     */
    test("accepts aud matching any entry in audience array", async () => {
      const { validator } = jwt({
        secret: SECRET,
        audience: ["https://a.example.com", "https://b.example.com"],
      });
      const token = signHs256(
        { sub: "user-1", aud: "https://b.example.com", exp: FUTURE },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).not.toBeNull();
    });

    /**
     * @case Token with non-matching aud is rejected
     * @preconditions jwt() configured with audience: "https://mcp.example.com"; token aud is "https://evil.example.com"
     * @expectedResult Validator returns null
     */
    test("rejects non-matching aud", async () => {
      const { validator } = jwt({
        secret: SECRET,
        audience: "https://mcp.example.com",
      });
      const token = signHs256(
        { sub: "user-1", aud: "https://evil.example.com", exp: FUTURE },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).toBeNull();
    });

    /**
     * @case Token with missing aud is rejected when audience is required
     * @preconditions jwt() configured with audience set; token omits aud
     * @expectedResult Validator returns null
     */
    test("rejects missing aud when audience is set", async () => {
      const { validator } = jwt({
        secret: SECRET,
        audience: "https://mcp.example.com",
      });
      const token = signHs256({ sub: "user-1", exp: FUTURE }, SECRET);
      const result = await validator!(token);
      expect(result).toBeNull();
    });
  });

  describe("backwards compatibility", () => {
    /**
     * @case Omitting both issuer and audience preserves pre-existing behaviour
     * @preconditions jwt() configured with only secret; token omits iss and aud
     * @expectedResult Validator returns a JwtPrincipal (no identity checks applied)
     */
    test("accepts token without iss/aud when neither option is set", async () => {
      const { validator } = jwt({ secret: SECRET });
      const token = signHs256({ sub: "user-1", exp: FUTURE }, SECRET);
      const result = await validator!(token);
      expect(result).not.toBeNull();
    });

    /**
     * @case Setting only issuer does not force audience check
     * @preconditions jwt() configured with issuer only; token has matching iss and no aud
     * @expectedResult Validator returns a JwtPrincipal
     */
    test("checking issuer does not force audience check", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: "https://idp.example.com",
      });
      const token = signHs256(
        { sub: "user-1", iss: "https://idp.example.com", exp: FUTURE },
        SECRET,
      );
      const result = await validator!(token);
      expect(result).not.toBeNull();
    });
  });
});
