import { afterEach, describe, expect, test } from "bun:test";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  authenticate,
  authorize,
  craft,
  isAuthentic,
  markAuthentic,
  simple,
  type EventName,
  type Principal,
} from "../../src/index.ts";

type FailedEventDetails = { details: { error: unknown } };

describe("authenticate() helper and the authenticity brand", () => {
  /**
   * @case authenticate() mints a principal that is branded authentic and frozen
   * @preconditions Call authenticate() with a subject and roles
   * @expectedResult isAuthentic() is true, the object is frozen, defaults applied
   */
  test("mints an authentic, frozen principal with defaults", () => {
    const p = authenticate({ subject: "user-1", roles: ["internal"] });

    expect(isAuthentic(p)).toBe(true);
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.kind).toBe("custom");
    expect(p.scheme).toBe("custom");
    expect(p.subject).toBe("user-1");
    expect(p.roles).toEqual(["internal"]);
  });

  /**
   * @case authenticate() preserves explicit kind, scheme, and claim fields
   * @preconditions Call authenticate() overriding kind and scheme and passing claims
   * @expectedResult The minted principal carries the provided values verbatim
   */
  test("preserves explicit fields", () => {
    const p = authenticate({
      kind: "jwt",
      scheme: "bearer",
      subject: "svc",
      scopes: ["read"],
      claims: { tenant: "acme" },
    });

    expect(p.kind).toBe("jwt");
    expect(p.scheme).toBe("bearer");
    expect(p.scopes).toEqual(["read"]);
    expect(p.claims).toEqual({ tenant: "acme" });
  });

  /**
   * @case authenticate() rejects a missing or empty subject
   * @preconditions Call authenticate() with an empty-string subject
   * @expectedResult Throws an RC5023-coded error
   */
  test("throws RC5023 without a subject", () => {
    let err: unknown;
    try {
      authenticate({ subject: "" });
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain("RC5023");
  });

  /**
   * @case isAuthentic() is false for self-asserted plain objects and non-objects
   * @preconditions Pass a plain principal-shaped object, null, and undefined
   * @expectedResult All return false; only markAuthentic() output is trusted
   */
  test("isAuthentic() rejects plain objects and non-objects", () => {
    const plain: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "x",
      roles: ["admin"],
    };
    expect(isAuthentic(plain)).toBe(false);
    expect(isAuthentic(null)).toBe(false);
    expect(isAuthentic(undefined)).toBe(false);
    expect(isAuthentic(markAuthentic(plain))).toBe(true);
  });

  /**
   * @case Spreading an authentic principal drops the brand (anti-forge)
   * @preconditions Mint an authentic principal, then spread it into a new object
   *                with elevated roles
   * @expectedResult The spread copy is NOT authentic, so it cannot be trusted
   */
  test("spread copy of an authentic principal loses the brand", () => {
    const real = authenticate({ subject: "user-1", roles: ["user"] });
    const forged = { ...real, roles: ["admin"] };

    expect(isAuthentic(real)).toBe(true);
    expect(isAuthentic(forged)).toBe(false);
  });

  /**
   * @case markAuthentic() is idempotent
   * @preconditions Brand a principal twice
   * @expectedResult The second call returns the same already-branded reference
   */
  test("markAuthentic() is idempotent", () => {
    const once = markAuthentic({
      kind: "custom",
      scheme: "bearer",
      subject: "x",
    });
    const twice = markAuthentic(once);
    expect(twice).toBe(once);
  });
});

describe(".authenticate() operation and authorize() authenticity gate", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case .authenticate() mints an identity that authorize() then accepts
   * @preconditions Route mints a principal with role "internal" then requires it
   * @expectedResult The destination receives the body; the gate passes
   */
  test(".authenticate() then authorize() passes", async () => {
    const s = spy<string>();

    t = await testContext()
      .routes(
        craft()
          .id("mint-ok")
          .from(simple("hello"))
          .authenticate(() => ({ subject: "user-1", roles: ["internal"] }))
          .validate(authorize({ roles: ["internal"] }))
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello"]);
    expect(s.lastReceived().principal?.subject).toBe("user-1");
    expect(isAuthentic(s.lastReceived().principal)).toBe(true);
  });

  /**
   * @case .authenticate() returning undefined leaves the caller anonymous
   * @preconditions Resolver returns undefined; a later authorize() requires a principal
   * @expectedResult exchange:failed fires RC5012 (no principal attached)
   */
  test(".authenticate() returning undefined attaches no principal", async () => {
    const s = spy<string>();

    t = await testContext()
      .routes(
        craft()
          .id("mint-none")
          .from(simple("hello"))
          .authenticate(() => undefined)
          .validate(authorize())
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on(
      "route:mint-none:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(String(failures[0])).toContain("RC5012");
  });

  /**
   * @case authorize() rejects a self-asserted principal written to headers
   * @preconditions A .process() step writes a plain principal object onto the
   *                principal header (no authenticate()), then authorize() runs
   * @expectedResult exchange:failed fires RC5023; the destination is skipped
   */
  test("authorize() rejects a raw principal with RC5023", async () => {
    const s = spy<string>();

    t = await testContext()
      .routes(
        craft()
          .id("raw-principal")
          .from(simple("hello"))
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": {
                kind: "custom",
                scheme: "bearer",
                subject: "attacker",
                roles: ["admin"],
              },
            },
          }))
          .validate(authorize({ roles: ["admin"] }))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on(
      "route:raw-principal:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(String(failures[0])).toContain("RC5023");
  });

  /**
   * @case Spread-elevating an authentic principal is rejected (anti-forge end to end)
   * @preconditions Mint a principal with role "user", then a .process() spreads it
   *                into a new object with role "admin" (which drops the brand),
   *                then authorize() requires "admin"
   * @expectedResult exchange:failed fires RC5023, not RC5015: the elevated copy
   *                 is not trusted at all
   */
  test("authorize() rejects a spread-elevated principal with RC5023", async () => {
    const s = spy<string>();

    t = await testContext()
      .routes(
        craft()
          .id("forge")
          .from(simple("hello"))
          .authenticate(() => ({ subject: "user-1", roles: ["user"] }))
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": {
                ...(ex.principal as Principal),
                roles: ["admin"],
              },
            },
          }))
          .validate(authorize({ roles: ["admin"] }))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on(
      "route:forge:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(String(failures[0])).toContain("RC5023");
  });
});
