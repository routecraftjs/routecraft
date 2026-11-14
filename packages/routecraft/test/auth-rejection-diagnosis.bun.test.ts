import { describe, expect, test } from "bun:test";
import { errors } from "jose";
import { testContext } from "@routecraft/testing";
import { createHmac } from "node:crypto";
import { diagnoseRejection, jwt } from "../src/index.ts";
import { HttpMountRegistry } from "../src/plugins/server/registry.ts";
import { ingressHostOf } from "./helpers/authority.ts";

const BEARER = "s3cr3t.bearer.value";
const CLAIMS = { sub: "alice", email: "alice@example.test", aud: "other-app" };

/**
 * One walled mount whose validator throws `thrown`, dispatched once with
 * {@link BEARER}. Returns what the ingress announced and logged.
 */
async function reject(thrown: unknown): Promise<{
  status: number;
  events: Array<Record<string, unknown>>;
  logs: Array<{ bindings: unknown; message: string }>;
}> {
  const built = await testContext().build();
  const events: Array<Record<string, unknown>> = [];
  built.ctx.on("auth:rejected", ({ details }) => {
    events.push(details as Record<string, unknown>);
  });
  const logs: Array<{ bindings: unknown; message: string }> = [];
  const host = ingressHostOf(built.ctx);
  const logger = Object.create(host.logger) as typeof host.logger;
  logger.debug = ((bindings: unknown, message: string) => {
    logs.push({ bindings, message });
  }) as typeof host.logger.debug;
  const ingress = new HttpMountRegistry(
    "secure",
    { ...host, logger },
    {
      validator: () => {
        throw thrown;
      },
    },
  );
  ingress.mountHttp({
    id: "surface",
    claims: () => [{ kind: "exact", path: "/private" }],
    handler: async (_request, mount) => {
      const auth = await mount.authenticate();
      return auth?.kind === "reject"
        ? auth.response
        : new Response("unreachable");
    },
  });
  ingress.validate();
  const response = await ingress.dispatch(
    new Request("http://local/private", {
      headers: { authorization: `Bearer ${BEARER}` },
    }),
  );
  return { status: response.status, events, logs };
}

describe("auth:rejected diagnosis", () => {
  /**
   * @case An audience mismatch and a signature failure are told apart by the event alone
   * @preconditions One validator throws jose's claim validation error for `aud`, another jose's signature verification error
   * @expectedResult Both events keep reason invalid_token; the first carries the claim code and the claim name, the second the signature code
   */
  test("tells an audience mismatch from a signature failure", async () => {
    const audience = await reject(
      new errors.JWTClaimValidationFailed(
        'unexpected "aud" claim value',
        CLAIMS,
        "aud",
        "check_failed",
      ),
    );
    const signature = await reject(new errors.JWSSignatureVerificationFailed());

    expect(audience.status).toBe(401);
    expect(audience.events).toEqual([
      {
        reason: "invalid_token",
        scheme: "bearer",
        source: "surface",
        code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
        claim: "aud",
      },
    ]);
    expect(signature.events).toEqual([
      {
        reason: "invalid_token",
        scheme: "bearer",
        source: "surface",
        code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
      },
    ]);
  });

  /**
   * @case The jose error is logged at debug without the token's claims
   * @preconditions The validator throws jose's claim validation error, which holds the whole claims set as `payload`
   * @expectedResult One debug line carries an `err` binding with the code alone, and no claim value appears in it
   */
  test("logs the jose error without the claims set", async () => {
    const { logs } = await reject(
      new errors.JWTClaimValidationFailed(
        'unexpected "aud" claim value',
        CLAIMS,
        "aud",
        "check_failed",
      ),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]?.bindings).toEqual({
      reason: "invalid_token",
      scheme: "bearer",
      source: "surface",
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "aud",
      err: { type: "JOSEError", code: "ERR_JWT_CLAIM_VALIDATION_FAILED" },
    });
    expect(JSON.stringify(logs)).not.toContain("alice");
  });

  /**
   * @case A custom validator that puts the bearer in its error leaks nothing
   * @preconditions The validator throws a plain Error whose message, code and claim all contain the presented bearer
   * @expectedResult The event carries only reason, scheme and source, and neither the event nor the log bindings contain the bearer
   */
  test("keeps a custom validator's error text out of the event and the log", async () => {
    const { events, logs } = await reject(
      Object.assign(new Error(`token ${BEARER} is not on the list`), {
        code: `ERR_JWT_${BEARER}`,
        claim: BEARER,
      }),
    );

    expect(events).toEqual([
      { reason: "invalid_token", scheme: "bearer", source: "surface" },
    ]);
    expect(logs).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(BEARER);
  });

  /**
   * @case Text a jose error quotes from the token never reaches the log
   * @preconditions The validator throws jose's not-supported error, whose message quotes a header parameter the caller chose, here the bearer
   * @expectedResult The event and the log binding carry the code, and neither contains the quoted text
   */
  test("keeps a jose error's own message out of the event and the log", async () => {
    const { events, logs } = await reject(
      new errors.JOSENotSupported(
        `Extension Header Parameter "${BEARER}" is not recognized`,
      ),
    );

    expect(events[0]?.["code"]).toBe("ERR_JOSE_NOT_SUPPORTED");
    expect(logs).toHaveLength(1);
    expect(JSON.stringify({ events, logs })).not.toContain(BEARER);
  });
});

describe("diagnoseRejection", () => {
  /**
   * @case The built-in jwt() verifier refuses a token for each reason it can
   * @preconditions An HS256 jwt() verifier for one issuer and audience; tokens with a wrong issuer, a wrong audience, a bad signature, another algorithm, no exp, an exp in the past, an nbf in the future, and a string that is not a token
   * @expectedResult Each refusal is diagnosed with the code jose gives the same failure and, for a claim, its name: a wrong issuer and a wrong audience are told apart
   */
  test("diagnoses every jwt() refusal", async () => {
    const secret = "k".repeat(32);
    const verifier = jwt({
      secret,
      issuer: "https://idp.test",
      audience: "app",
    });
    const now = Math.floor(Date.now() / 1000);
    const good = {
      iss: "https://idp.test",
      aud: "app",
      sub: "a",
      exp: now + 60,
    };
    const sign = (payload: object, alg = "HS256", key = secret): string => {
      const part = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const body = `${part({ alg, typ: "JWT" })}.${part(payload)}`;
      const mac = createHmac(alg === "HS512" ? "sha512" : "sha256", key)
        .update(body)
        .digest("base64url");
      return `${body}.${mac}`;
    };
    const diagnosed = async (token: string) => {
      try {
        await verifier.validator(token);
      } catch (err) {
        return diagnoseRejection(err).fields;
      }
      throw new Error("the token was admitted");
    };
    const claim = "ERR_JWT_CLAIM_VALIDATION_FAILED";

    expect(
      await diagnosed(sign({ ...good, iss: "https://other.test" })),
    ).toEqual({ code: claim, claim: "iss" });
    expect(await diagnosed(sign({ ...good, aud: "other" }))).toEqual({
      code: claim,
      claim: "aud",
    });
    expect(await diagnosed(sign(good, "HS256", "x".repeat(32)))).toEqual({
      code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });
    expect(await diagnosed(sign(good, "HS512"))).toEqual({
      code: "ERR_JOSE_ALG_NOT_ALLOWED",
    });
    const noExp = { iss: good.iss, aud: good.aud, sub: good.sub };
    expect(await diagnosed(sign(noExp))).toEqual({ code: claim, claim: "exp" });
    expect(await diagnosed(sign({ ...good, exp: now - 60 }))).toEqual({
      code: "ERR_JWT_EXPIRED",
      claim: "exp",
    });
    expect(await diagnosed(sign({ ...good, nbf: now + 600 }))).toEqual({
      code: claim,
      claim: "nbf",
    });
    expect(await diagnosed("not-a-token")).toEqual({ code: "ERR_JWT_INVALID" });
  });

  /**
   * @case A jose error nested under a wrapping error is still diagnosed
   * @preconditions A plain Error whose cause is jose's no-matching-key error
   * @expectedResult The diagnosis carries the nested error's code
   */
  test("reads the code through the cause chain", () => {
    const wrapped = new Error("verification failed", {
      cause: new errors.JWKSNoMatchingKey(),
    });

    expect(diagnoseRejection(wrapped).fields.code).toBe(
      "ERR_JWKS_NO_MATCHING_KEY",
    );
  });

  /**
   * @case A claim name outside the registered set is withheld
   * @preconditions A jose claim validation error for a required custom claim
   * @expectedResult The diagnosis carries the code and no claim
   */
  test("names only registered claims", () => {
    const diagnosis = diagnoseRejection(
      new errors.JWTClaimValidationFailed(
        'missing required "tenant" claim',
        {},
        "tenant",
        "missing",
      ),
    );

    expect(diagnosis.fields).toEqual({
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    });
  });

  /**
   * @case An error that is not one of jose's yields nothing
   * @preconditions A plain Error, and a non-object value
   * @expectedResult An empty diagnosis for both
   */
  test("returns nothing for an error that is not jose's", () => {
    expect(diagnoseRejection(new Error("nope"))).toEqual({ fields: {} });
    expect(diagnoseRejection("nope")).toEqual({ fields: {} });
  });
});
