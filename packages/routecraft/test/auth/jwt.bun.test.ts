import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { jwt, type JwtAuthOptions } from "../../src/auth/jwt.ts";
import { markAuthentic } from "../../src/auth/authentic.ts";
import type { Principal } from "../../src/auth/types.ts";

/**
 * Sign a JWT with HS256 using the test secret. Returns the full compact
 * token without pulling in a JWT library.
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
const ISSUER = "https://idp.example.com";
const AUDIENCE = "https://mcp.example.com";

describe("jwt()", () => {
  describe("required options", () => {
    /**
     * @case Factory rejects HMAC options that omit issuer to prevent cross-issuer replay
     * @preconditions jwt({ secret }) called without issuer
     * @expectedResult Throws TypeError mentioning issuer
     */
    test("throws when issuer is omitted", () => {
      expect(() =>
        jwt({
          secret: SECRET,
          audience: AUDIENCE,
        } as unknown as JwtAuthOptions),
      ).toThrow(/issuer/);
    });

    /**
     * @case Factory rejects HMAC options that omit audience to prevent cross-audience replay
     * @preconditions jwt({ secret, issuer }) called without audience
     * @expectedResult Throws TypeError mentioning audience
     */
    test("throws when audience is omitted", () => {
      expect(() =>
        jwt({ secret: SECRET, issuer: ISSUER } as unknown as JwtAuthOptions),
      ).toThrow(/audience/);
    });

    /**
     * @case Factory rejects empty-string issuer so an unset env var cannot silently disable the check
     * @preconditions issuer is an empty string
     * @expectedResult Throws TypeError mentioning issuer
     */
    test("throws when issuer is empty", () => {
      expect(() =>
        jwt({ secret: SECRET, issuer: "", audience: AUDIENCE }),
      ).toThrow(/issuer/);
    });

    /**
     * @case Factory rejects empty-string audience so an unset env var cannot silently disable the check
     * @preconditions audience is an empty string
     * @expectedResult Throws TypeError mentioning audience
     */
    test("throws when audience is empty", () => {
      expect(() =>
        jwt({ secret: SECRET, issuer: ISSUER, audience: "" }),
      ).toThrow(/audience/);
    });

    /**
     * @case Factory accepts "*" as a valid audience sentinel
     * @preconditions jwt() called with audience: "*"
     * @expectedResult No error thrown
     */
    test('accepts "*" as audience sentinel', () => {
      expect(() =>
        jwt({ secret: SECRET, issuer: ISSUER, audience: "*" }),
      ).not.toThrow();
    });
  });

  describe("issuer validation", () => {
    /**
     * @case Token with matching iss is accepted when issuer is a single string
     * @preconditions jwt() configured with issuer and audience; token carries both claims matching
     * @expectedResult Validator resolves to a Principal with subject from sub
     */
    test("accepts matching iss when issuer is a single string", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, aud: AUDIENCE, exp: FUTURE },
        SECRET,
      );
      const result = (await validator(token)) as Principal;
      expect(result.subject).toBe("user-1");
      expect(result.issuer).toBe(ISSUER);
      expect(result.kind).toBe("jwt");
    });

    /**
     * @case Token with iss matching any entry in array is accepted
     * @preconditions jwt() configured with issuer: ["a", "b"] and audience; token carries iss: "b"
     * @expectedResult Validator resolves to a Principal
     */
    test("accepts iss matching any entry in issuer array", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ["https://a.example.com", "https://b.example.com"],
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: "https://b.example.com",
          aud: AUDIENCE,
          exp: FUTURE,
        },
        SECRET,
      );
      await expect(validator(token)).resolves.toBeDefined();
    });

    /**
     * @case Token with non-matching iss is rejected
     * @preconditions jwt() configured with issuer + audience; token iss is an unexpected value
     * @expectedResult Validator throws
     */
    test("rejects non-matching iss", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: "https://evil.example.com",
          aud: AUDIENCE,
          exp: FUTURE,
        },
        SECRET,
      );
      await expect(validator(token)).rejects.toThrow();
    });

    /**
     * @case Token with missing iss is rejected
     * @preconditions jwt() configured with issuer + audience; token omits iss
     * @expectedResult Validator throws
     */
    test("rejects missing iss", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { sub: "user-1", aud: AUDIENCE, exp: FUTURE },
        SECRET,
      );
      await expect(validator(token)).rejects.toThrow();
    });
  });

  describe("audience validation", () => {
    /**
     * @case Token with string aud matching is accepted when audience is a single string
     * @preconditions jwt() configured with issuer + audience; token aud is the same string
     * @expectedResult Validator resolves to a Principal with audience populated
     */
    test("accepts string aud matching single audience", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, aud: AUDIENCE, exp: FUTURE },
        SECRET,
      );
      const result = (await validator(token)) as Principal;
      expect(result.audience).toEqual([AUDIENCE]);
    });

    /**
     * @case Token with array aud containing the expected audience is accepted
     * @preconditions jwt() configured with issuer + audience; token aud is ["other", audience]
     * @expectedResult Validator resolves to a Principal
     */
    test("accepts array aud containing expected audience", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: ["https://other.example.com", AUDIENCE],
          exp: FUTURE,
        },
        SECRET,
      );
      await expect(validator(token)).resolves.toBeDefined();
    });

    /**
     * @case Token with aud matching any entry when audience is an array
     * @preconditions jwt() configured with issuer + audience: ["a", "b"]; token aud is "b"
     * @expectedResult Validator resolves to a Principal
     */
    test("accepts aud matching any entry in audience array", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: ["https://a.example.com", "https://b.example.com"],
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: "https://b.example.com",
          exp: FUTURE,
        },
        SECRET,
      );
      await expect(validator(token)).resolves.toBeDefined();
    });

    /**
     * @case Token with non-matching aud is rejected
     * @preconditions jwt() configured with issuer + audience; token aud is unexpected
     * @expectedResult Validator throws
     */
    test("rejects non-matching aud", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: "https://evil.example.com",
          exp: FUTURE,
        },
        SECRET,
      );
      await expect(validator(token)).rejects.toThrow();
    });

    /**
     * @case Token with missing aud is rejected when audience is a specific value
     * @preconditions jwt() configured with issuer + audience; token omits aud
     * @expectedResult Validator throws
     */
    test("rejects missing aud when audience is a specific value", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, exp: FUTURE },
        SECRET,
      );
      await expect(validator(token)).rejects.toThrow();
    });

    /**
     * @case Token with any aud is accepted when audience is "*"
     * @preconditions jwt() configured with audience: "*"; token carries unexpected aud
     * @expectedResult Validator resolves; audience field mapped from token payload
     */
    test('accepts any aud when audience is "*"', async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: "*",
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, aud: "some-other-resource", exp: FUTURE },
        SECRET,
      );
      const result = await validator(token);
      expect(result.subject).toBe("user-1");
      expect(result.audience).toEqual(["some-other-resource"]);
    });

    /**
     * @case Token with no aud is accepted when audience is "*"
     * @preconditions jwt() configured with audience: "*"; token omits aud
     * @expectedResult Validator resolves; principal.audience is undefined
     */
    test('accepts token with no aud when audience is "*"', async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: "*",
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, exp: FUTURE },
        SECRET,
      );
      const result = await validator(token);
      expect(result.subject).toBe("user-1");
      expect(result.audience).toBeUndefined();
    });
  });

  describe("claims mappers", () => {
    /**
     * @case Custom subject mapper overrides the default sub extraction
     * @preconditions jwt() with claims.subject override; token carries non-standard identity field
     * @expectedResult Principal.subject comes from the override callback
     */
    test("applies claims.subject override", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
        claims: { subject: (p) => p["oid"] as string },
      });
      const token = signHs256(
        {
          oid: "azure-oid",
          sub: "ignored",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FUTURE,
        },
        SECRET,
      );
      const result = await validator(token);
      expect(result.subject).toBe("azure-oid");
    });
  });

  describe("principal shape", () => {
    /**
     * @case Standard JWT claims are mapped to the unified Principal fields
     * @preconditions Token carries sub, iss, aud, exp, email, name, scope, roles
     * @expectedResult All standard fields surface on the returned Principal with kind "jwt"
     */
    test("maps standard claims to Principal fields", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-42",
          client_id: "client-abc",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FUTURE,
          email: "ada@example.com",
          name: "Ada Lovelace",
          scope: "email profile",
          roles: ["admin"],
        },
        SECRET,
      );
      const result = await validator(token);
      expect(result.kind).toBe("jwt");
      expect(result.scheme).toBe("bearer");
      expect(result.subject).toBe("user-42");
      expect(result.clientId).toBe("client-abc");
      expect(result.email).toBe("ada@example.com");
      expect(result.name).toBe("Ada Lovelace");
      expect(result.issuer).toBe(ISSUER);
      expect(result.audience).toEqual([AUDIENCE]);
      expect(result.scopes).toEqual(["email", "profile"]);
      expect(result.roles).toEqual(["admin"]);
      expect(result.expiresAt).toBe(FUTURE);
      expect(result.claims).toMatchObject({ sub: "user-42" });
    });

    /**
     * @case Token without sub falls back to client_id for subject
     * @preconditions Token omits sub but carries client_id (client-credentials pattern)
     * @expectedResult Principal.subject is the client_id value
     */
    test("falls back to client_id when sub is absent", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { client_id: "svc-account", iss: ISSUER, aud: AUDIENCE, exp: FUTURE },
        SECRET,
      );
      const result = await validator(token);
      expect(result.subject).toBe("svc-account");
    });
  });

  describe("issuer propagation", () => {
    /**
     * @case jwt() surfaces a string issuer on its returned options
     * @preconditions jwt({ issuer: "https://idp.example.com", ... })
     * @expectedResult Returned object carries `issuer` equal to the configured value
     */
    test("string issuer is exposed on the returned options", () => {
      const result = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      expect(result.issuer).toBe(ISSUER);
    });

    /**
     * @case jwt() preserves an array issuer on its returned options
     * @preconditions jwt({ issuer: [a, b], ... })
     * @expectedResult Returned object carries the exact issuer array
     */
    test("string[] issuer is exposed on the returned options", () => {
      const issuers = [ISSUER, "https://alt.example.com"];
      const result = jwt({
        secret: SECRET,
        issuer: issuers,
        audience: AUDIENCE,
      });
      expect(result.issuer).toEqual(issuers);
    });
  });

  describe("temporal claims", () => {
    const PAST = Math.floor(Date.now() / 1000) - 3600;
    const FAR_FUTURE = Math.floor(Date.now() / 1000) + 7200;

    /**
     * @case An expired token is rejected with jose's ERR_JWT_EXPIRED code
     * @preconditions jwt() validator; token whose exp is in the past
     * @expectedResult Rejects with an error carrying code "ERR_JWT_EXPIRED" so log-level classification matches jwks()
     */
    test("rejects an expired token with the ERR_JWT_EXPIRED code", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, aud: AUDIENCE, exp: PAST },
        SECRET,
      );
      let caught: unknown;
      try {
        await validator(token);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { code?: string }).code).toBe("ERR_JWT_EXPIRED");
    });

    /**
     * @case A not-yet-valid token is rejected without the expiry code
     * @preconditions jwt() validator; token whose nbf is in the future and exp is valid
     * @expectedResult Rejects, but the error does NOT carry ERR_JWT_EXPIRED (nbf is not routine expiry)
     */
    test("rejects a not-yet-valid token without the expiry code", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FAR_FUTURE,
          nbf: FAR_FUTURE,
        },
        SECRET,
      );
      let caught: unknown;
      try {
        await validator(token);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { code?: string }).code).not.toBe("ERR_JWT_EXPIRED");
    });

    /**
     * @case A token missing the exp claim is rejected
     * @preconditions jwt() validator; token with no exp claim
     * @expectedResult Rejects (jwt() requires a bearer-token expiry)
     */
    test("rejects a token missing the exp claim", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        { sub: "user-1", iss: ISSUER, aud: AUDIENCE },
        SECRET,
      );
      await expect(validator(token)).rejects.toThrow(/exp/);
    });
  });

  describe("delegation claims", () => {
    /**
     * @case act, may_act, and sub_profile round-trip from a verified token onto the Principal
     * @preconditions Token carries nested act {sub, iss, sub_profile, act}, a may_act object, sub_profile, and a roles array
     * @expectedResult Principal has the full actor chain (outermost first), mayAct matcher, subjectProfile, and roles; matches what an in-process delegate() would produce
     */
    test("parses act, may_act, sub_profile, and roles claims", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user_jaco",
          sub_profile: "user",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FUTURE,
          roles: ["member", "admin"],
          scope: "mail:send",
          act: {
            sub: "agent:max",
            iss: "https://agents.example.com",
            sub_profile: "ai_agent",
            act: { sub: "agent:zoe", iss: "https://agents.example.com" },
          },
          may_act: { sub: "agent:zoe", iss: "https://agents.example.com" },
        },
        SECRET,
      );

      const principal: Principal = await validator(token);
      expect(principal.subject).toBe("user_jaco");
      expect(principal.subjectProfile).toBe("user");
      expect(principal.roles).toEqual(["member", "admin"]);
      expect(principal.actor?.subject).toBe("agent:max");
      expect(principal.actor?.subjectProfile).toBe("ai_agent");
      expect(principal.actor?.actor?.subject).toBe("agent:zoe");
      expect(principal.actor?.actor?.actor).toBeUndefined();
      expect(principal.mayAct).toEqual([
        { subject: "agent:zoe", issuer: "https://agents.example.com" },
      ]);
    });

    /**
     * @case ClaimMappers.roles overrides the default roles claim location
     * @preconditions Token nests roles under realm_access.roles (Keycloak shape); claims.roles mapper supplied
     * @expectedResult Principal.roles comes from the mapped location
     */
    test("maps roles from a non-standard claim via claims.roles", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
        claims: {
          roles: (payload) =>
            (payload["realm_access"] as { roles?: string[] } | undefined)
              ?.roles,
        },
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FUTURE,
          realm_access: { roles: ["member"] },
        },
        SECRET,
      );

      const principal: Principal = await validator(token);
      expect(principal.roles).toEqual(["member"]);
    });

    /**
     * @case An act claim the parser cannot identify rejects the token instead of dropping the actor
     * @preconditions Token carries act identified by client_id (no sub), a non-object act, and an act nested past the depth cap
     * @expectedResult Every variant rejects. Dropping the actor would leave a delegated token indistinguishable from a direct call, which passes the authorize({ actor: 'none' }) default
     */
    test("rejects a token whose act claim has no usable sub", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const base = { sub: "user-1", iss: ISSUER, aud: AUDIENCE, exp: FUTURE };

      // A client-credentials actor: the shape most likely to lack `sub`.
      await expect(
        validator(
          signHs256(
            { ...base, act: { client_id: "agent:zoe", iss: "https://a" } },
            SECRET,
          ),
        ),
      ).rejects.toThrow(/act/);

      await expect(
        validator(signHs256({ ...base, act: "agent:zoe" }, SECRET)),
      ).rejects.toThrow(/act/);

      let deep: Record<string, unknown> = { sub: "agent:0" };
      for (let i = 1; i <= 20; i++) deep = { sub: `agent:${i}`, act: deep };
      await expect(
        validator(signHs256({ ...base, act: deep }, SECRET)),
      ).rejects.toThrow(/deeper than/);
    });

    /**
     * @case A may_act claim the parser cannot read rejects the token instead of removing the restriction
     * @preconditions Token carries may_act identified by client_id, and a non-object may_act
     * @expectedResult Both reject. An unreadable may_act resolving to undefined would mean "anyone may act", inverting a claim whose purpose is to restrict
     */
    test("rejects a token whose may_act claim has no usable sub", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const base = { sub: "user-1", iss: ISSUER, aud: AUDIENCE, exp: FUTURE };

      await expect(
        validator(
          signHs256({ ...base, may_act: { client_id: "agent:zoe" } }, SECRET),
        ),
      ).rejects.toThrow(/may_act/);

      await expect(
        validator(signHs256({ ...base, may_act: "agent:zoe" }, SECRET)),
      ).rejects.toThrow(/may_act/);
    });

    /**
     * @case Claim mappers accept non-standard actor and may_act shapes that the default parser refuses
     * @preconditions Token identifies both by client_id; claims.actor and claims.mayAct map them
     * @expectedResult Verification succeeds and both fields are populated from the mapped values
     */
    test("claims.actor and claims.mayAct map non-standard shapes", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
        claims: {
          actor: (payload) => {
            const act = payload["act"] as
              { client_id?: string; iss?: string } | undefined;
            return act?.client_id
              ? {
                  kind: "jwt",
                  scheme: "bearer",
                  subject: act.client_id,
                  ...(act.iss ? { issuer: act.iss } : {}),
                }
              : undefined;
          },
          mayAct: (payload) => {
            const may = payload["may_act"] as
              { client_id?: string } | undefined;
            return may?.client_id ? [{ subject: may.client_id }] : undefined;
          },
        },
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FUTURE,
          act: { client_id: "agent:zoe", iss: "https://agents.example.com" },
          may_act: { client_id: "agent:zoe" },
        },
        SECRET,
      );

      const principal: Principal = await validator(token);
      expect(principal.actor?.subject).toBe("agent:zoe");
      expect(principal.actor?.issuer).toBe("https://agents.example.com");
      expect(principal.mayAct).toEqual([{ subject: "agent:zoe" }]);
    });

    /**
     * @case A supplied mapper replaces the default parser entirely, including its undefined results
     * @preconditions Token carries RFC-8693-shaped act and may_act (with sub); claims.actor and claims.mayAct mappers deliberately return undefined
     * @expectedResult Principal has no actor and no mayAct; the default parser must not reinstate what the mapper decided against
     */
    test("mapper undefined results are not overridden by the default parser", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
        claims: {
          actor: () => undefined,
          mayAct: () => undefined,
        },
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FUTURE,
          act: { sub: "agent:zoe" },
          may_act: { sub: "agent:zoe" },
        },
        SECRET,
      );

      const principal: Principal = await validator(token);
      expect(principal.actor).toBeUndefined();
      expect(principal.mayAct).toBeUndefined();
    });

    /**
     * @case may_act narrowing constraints beyond sub and iss are preserved
     * @preconditions Token may_act carries sub_profile and roles
     * @expectedResult The matcher keeps profile and roles, so the in-process gate is no wider than the token stated
     */
    test("keeps profile and roles from a may_act entry", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FUTURE,
          may_act: {
            sub: "agent:zoe",
            iss: "https://agents.example.com",
            sub_profile: "ai_agent",
            roles: ["ops"],
          },
        },
        SECRET,
      );

      const principal: Principal = await validator(token);
      expect(principal.mayAct).toEqual([
        {
          subject: "agent:zoe",
          issuer: "https://agents.example.com",
          profile: "ai_agent",
          roles: ["ops"],
        },
      ]);
    });

    /**
     * @case The parsed actor chain and mayAct are frozen once branded authentic
     * @preconditions Verified token with a nested act chain and a may_act entry
     * @expectedResult Mutating the current actor, a nested actor, or the mayAct list all throw, so an in-process holder cannot rewrite policy inputs
     */
    test("freezes the parsed delegation state", async () => {
      const { validator } = jwt({
        secret: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const token = signHs256(
        {
          sub: "user-1",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: FUTURE,
          act: {
            sub: "agent:max",
            act: { sub: "agent:zoe" },
          },
          may_act: { sub: "agent:zoe" },
        },
        SECRET,
      );

      const principal = markAuthentic(await validator(token));
      expect(Object.isFrozen(principal.actor)).toBe(true);
      expect(Object.isFrozen(principal.actor?.actor)).toBe(true);
      expect(Object.isFrozen(principal.mayAct)).toBe(true);
      expect(() => {
        (principal.actor as { subject: string }).subject = "agent:superuser";
      }).toThrow(TypeError);
      expect(() => {
        principal.mayAct?.push({ subject: "agent:evil" });
      }).toThrow(TypeError);
    });
  });
});
