import { afterEach, describe, expect, test } from "bun:test";

/** String form of whatever `fn` throws, "" when it does not throw. */
function thrownString(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (err) {
    return String(err);
  }
}
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  authenticate,
  authorize,
  craft,
  delegate,
  isAuthentic,
  simple,
  type Principal,
  type PrincipalClaims,
} from "../../src/index.ts";

const EYWA_ISS = "https://agents.example.com";

const zoeClaims: PrincipalClaims = {
  subject: "agent:zoe",
  subjectProfile: "ai_agent",
  issuer: EYWA_ISS,
  roles: ["agent"],
  scopes: ["mail:send", "kb:read"],
};

function jaco(overrides: Partial<PrincipalClaims> = {}): Principal {
  return authenticate({
    subject: "user_jaco",
    subjectProfile: "user",
    issuer: "https://idp.example.com",
    roles: ["member", "admin"],
    scopes: ["mail:send", "employees:read"],
    ...overrides,
  });
}

describe("delegate() helper", () => {
  /**
   * @case Delegation sets the actor and keeps the subject
   * @preconditions Authentic user principal, agent claims, no scope ceiling
   * @expectedResult subject/roles unchanged, actor minted with agent identity, result is authentic
   */
  test("keeps subject, sets actor, brands the result", () => {
    const delegated = delegate(jaco(), zoeClaims);

    expect(delegated.subject).toBe("user_jaco");
    expect(delegated.roles).toEqual(["member", "admin"]);
    expect(delegated.actor?.subject).toBe("agent:zoe");
    expect(delegated.actor?.subjectProfile).toBe("ai_agent");
    expect(isAuthentic(delegated)).toBe(true);
  });

  /**
   * @case Scopes intersect across subject, ceiling, and actor; roles pass through
   * @preconditions Subject has [mail:send, employees:read], ceiling [mail:send, kb:read], actor [mail:send, kb:read]
   * @expectedResult Effective scopes are exactly [mail:send]; subject roles untouched
   */
  test("intersects scopes and passes roles through", () => {
    const delegated = delegate(jaco(), zoeClaims, {
      scopes: ["mail:send", "kb:read"],
    });

    expect(delegated.scopes).toEqual(["mail:send"]);
    expect(delegated.roles).toEqual(["member", "admin"]);
    expect(delegated.actor?.roles).toEqual(["agent"]);
  });

  /**
   * @case A scope ceiling over a scope-less subject grants nothing
   * @preconditions Subject principal has no scopes field, ceiling requests [mail:send]
   * @expectedResult Effective scopes are [] (empty), not the ceiling
   */
  test("ceiling cannot conjure scopes the subject never held", () => {
    const noScopes = authenticate({
      subject: "user_plain",
      roles: ["member"],
    });
    const delegated = delegate(noScopes, zoeClaims, {
      scopes: ["mail:send"],
    });

    expect(delegated.scopes).toEqual([]);
  });

  /**
   * @case Re-delegation nests the previous actor one level down
   * @preconditions Principal already delegated to zoe, then delegated to max
   * @expectedResult Outermost actor is max, nested actor is zoe, subject still the user
   */
  test("chains: outermost actor is the current one", () => {
    const viaZoe = delegate(jaco(), zoeClaims);
    const viaMax = delegate(viaZoe, {
      subject: "agent:max",
      subjectProfile: "ai_agent",
      issuer: EYWA_ISS,
    });

    expect(viaMax.subject).toBe("user_jaco");
    expect(viaMax.actor?.subject).toBe("agent:max");
    expect(viaMax.actor?.actor?.subject).toBe("agent:zoe");
    expect(viaMax.actor?.actor?.actor).toBeUndefined();
  });

  /**
   * @case Delegating a non-authentic principal is refused
   * @preconditions Subject is a plain object, never minted
   * @expectedResult delegate() throws RC5023
   */
  test("rejects a self-asserted subject with RC5023", () => {
    const forged: Principal = {
      kind: "custom",
      scheme: "custom",
      subject: "user_forged",
      roles: ["admin"],
    };

    expect(thrownString(() => delegate(forged, zoeClaims))).toContain("RC5023");
  });

  /**
   * @case mayAct restricts who may become the actor
   * @preconditions Subject permits only agent:zoe@EYWA_ISS; delegation to agent:max attempted
   * @expectedResult delegate() throws RC5037; delegation to zoe succeeds
   */
  test("enforces mayAct with RC5037", () => {
    const restricted = jaco({
      mayAct: [{ subject: "agent:zoe", issuer: EYWA_ISS }],
    });

    expect(
      thrownString(() =>
        delegate(restricted, { subject: "agent:max", issuer: EYWA_ISS }),
      ),
    ).toContain("RC5037");
    expect(delegate(restricted, zoeClaims).actor?.subject).toBe("agent:zoe");
  });

  /**
   * @case mayAct matching is the (issuer, subject) pair, not subject alone
   * @preconditions Subject permits agent:zoe at EYWA_ISS; a same-named agent from another issuer delegates
   * @expectedResult delegate() throws RC5037 for the wrong-issuer actor
   */
  test("mayAct rejects a same-named actor from a different issuer", () => {
    const restricted = jaco({
      mayAct: [{ subject: "agent:zoe", issuer: EYWA_ISS }],
    });

    expect(
      thrownString(() =>
        delegate(restricted, {
          subject: "agent:zoe",
          issuer: "https://evil.example.com",
        }),
      ),
    ).toContain("RC5037");
  });

  /**
   * @case Delegated expiry is the earlier of subject and actor expiry
   * @preconditions Subject expires at 2000, actor at 1000
   * @expectedResult Delegated principal expires at 1000
   */
  test("expiresAt becomes the minimum of both parties", () => {
    const subject = jaco({ expiresAt: 2000 });
    const delegated = delegate(subject, { ...zoeClaims, expiresAt: 1000 });

    expect(delegated.expiresAt).toBe(1000);
  });

  /**
   * @case grantId is carried onto the delegated principal
   * @preconditions Options pass grantId "grant_1"
   * @expectedResult Delegated principal carries grantId "grant_1"
   */
  test("carries the grantId for audit", () => {
    const delegated = delegate(jaco(), zoeClaims, { grantId: "grant_1" });
    expect(delegated.grantId).toBe("grant_1");
  });
});

describe("authorize() delegation awareness", () => {
  type FailedEventDetails = { details: { error: unknown } };

  async function run(
    principalFactory: () => Principal,
    options: Parameters<typeof authorize>[0],
  ): Promise<{ delivered: number; failure: string }> {
    const s = spy<string>();
    const t = await testContext()
      .routes(
        craft()
          .id("delegation")
          .from(simple("hello"))
          .authenticate(() => principalFactory())
          .validate(authorize(options))
          .to(s),
      )
      .build();
    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);
    try {
      await t.test();
    } finally {
      await t.stop();
    }
    return {
      delivered: s.received.length,
      failure: failures.length > 0 ? String(failures[0]) : "",
    };
  }

  // .authenticate() re-mints, so factories below hand back pre-built
  // principals; authenticate() accepts full Principal-shaped claims.
  const direct = () => jaco();
  const viaZoe = () => delegate(jaco(), zoeClaims);
  const viaMaxViaZoe = () =>
    delegate(delegate(jaco(), zoeClaims), {
      subject: "agent:max",
      subjectProfile: "ai_agent",
      issuer: EYWA_ISS,
    });

  /**
   * @case Default actor spec is 'none': delegated principals are rejected
   * @preconditions Principal delegated to zoe; authorize() with no actor option
   * @expectedResult RC5034 fires, destination skipped; direct caller passes the same route
   */
  test("rejects a delegated principal by default with RC5034", async () => {
    const delegated = await run(viaZoe, {});
    expect(delegated.delivered).toBe(0);
    expect(delegated.failure).toContain("RC5034");

    const plain = await run(direct, {});
    expect(plain.delivered).toBe(1);
  });

  /**
   * @case An ActorMatcher admits the named agent and 'none' in the array admits direct calls
   * @preconditions actor: ['none', zoe matcher]; run once direct, once via zoe
   * @expectedResult Both deliveries succeed
   */
  test("array spec ORs 'none' with a matcher", async () => {
    const spec = {
      actor: ["none" as const, { subject: "agent:zoe", issuer: EYWA_ISS }],
    };
    expect((await run(direct, spec)).delivered).toBe(1);
    expect((await run(viaZoe, spec)).delivered).toBe(1);
  });

  /**
   * @case Only the outermost actor is a policy input (RFC 8693 section 4.1)
   * @preconditions Chain user->zoe->max; route admits zoe only, depth 2 allowed
   * @expectedResult RC5034: the current actor is max, the nested zoe entry must not satisfy the matcher
   */
  test("matches the outermost actor only", async () => {
    const res = await run(viaMaxViaZoe, {
      actor: { subject: "agent:zoe", issuer: EYWA_ISS },
      maxDelegationDepth: 2,
    });
    expect(res.delivered).toBe(0);
    expect(res.failure).toContain("RC5034");
  });

  /**
   * @case maxDelegationDepth defaults to 1 and rejects deeper chains
   * @preconditions Chain of depth 2 (zoe then max); actor: 'any'
   * @expectedResult RC5036 fires; raising maxDelegationDepth to 2 admits it
   */
  test("bounds chain depth with RC5036", async () => {
    const deep = await run(viaMaxViaZoe, { actor: "any" });
    expect(deep.delivered).toBe(0);
    expect(deep.failure).toContain("RC5036");

    const allowed = await run(viaMaxViaZoe, {
      actor: "any",
      maxDelegationDepth: 2,
    });
    expect(allowed.delivered).toBe(1);
  });

  /**
   * @case Subject matcher gates on profile
   * @preconditions Route requires subject profile 'ai_agent'; a user principal calls
   * @expectedResult RC5035 for the user; an agent-subject principal passes
   */
  test("rejects wrong subject profile with RC5035", async () => {
    const res = await run(direct, {
      subject: { profile: "ai_agent" },
    });
    expect(res.delivered).toBe(0);
    expect(res.failure).toContain("RC5035");

    const agentSelf = () =>
      authenticate({
        subject: "agent:zoe",
        subjectProfile: "ai_agent",
        issuer: EYWA_ISS,
        roles: ["agent"],
      });
    const ok = await run(agentSelf, { subject: { profile: "ai_agent" } });
    expect(ok.delivered).toBe(1);
  });

  /**
   * @case Roles check the subject even when an actor drives; scopes check the narrowed set
   * @preconditions Delegation with ceiling [mail:send]; route requires roles [member] and scopes [employees:read]
   * @expectedResult Role check passes (subject attribute), scope check fails RC5038 (intersected away)
   */
  test("roles pass through delegation while scopes narrow", async () => {
    const res = await run(
      () => delegate(jaco(), zoeClaims, { scopes: ["mail:send"] }),
      {
        roles: ["member"],
        scopes: ["employees:read"],
        actor: "any",
      },
    );
    expect(res.delivered).toBe(0);
    expect(res.failure).toContain("RC5038");
    expect(res.failure).toContain("employees:read");
  });

  /**
   * @case A predicate actor spec receives both actor and subject
   * @preconditions actor spec is a function requiring an ai_agent actor for an admin subject
   * @expectedResult Delegated principal passes; direct call is rejected with RC5034
   */
  test("supports a predicate actor spec", async () => {
    const spec = {
      actor: (actor: Principal | undefined, subject: Principal) =>
        actor?.subjectProfile === "ai_agent" &&
        (subject.roles ?? []).includes("admin"),
    };
    expect((await run(viaZoe, spec)).delivered).toBe(1);
    const res = await run(direct, spec);
    expect(res.delivered).toBe(0);
    expect(res.failure).toContain("RC5034");
  });
});

describe(".delegate() builder step", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case The builder step mints the delegated principal onto the exchange
   * @preconditions .authenticate() mints the user, .delegate() returns zoe claims with a ceiling
   * @expectedResult Downstream exchange.principal has subject user, actor zoe, intersected scopes
   */
  test("delegates mid-route", async () => {
    const s = spy<string>();
    t = await testContext()
      .routes(
        craft()
          .id("step")
          .from(simple("hello"))
          .authenticate(() => jaco())
          .delegate(() => ({ actor: zoeClaims, scopes: ["mail:send"] }))
          .validate(
            authorize({
              actor: { subject: "agent:zoe", issuer: EYWA_ISS },
            }),
          )
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello"]);
    const principal = s.lastReceived().principal;
    expect(principal?.subject).toBe("user_jaco");
    expect(principal?.actor?.subject).toBe("agent:zoe");
    expect(principal?.scopes).toEqual(["mail:send"]);
  });

  /**
   * @case A resolver returning undefined leaves the exchange untouched
   * @preconditions .delegate() resolver returns undefined (no consent record)
   * @expectedResult Principal is unchanged (no actor); default authorize() passes it
   */
  test("undefined resolver result skips delegation", async () => {
    const s = spy<string>();
    t = await testContext()
      .routes(
        craft()
          .id("skip")
          .from(simple("hello"))
          .authenticate(() => jaco())
          .delegate(() => undefined)
          .validate(authorize())
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello"]);
    expect(s.lastReceived().principal?.actor).toBeUndefined();
  });

  /**
   * @case A directive on an anonymous exchange fails
   * @preconditions No .authenticate(); .delegate() returns a directive anyway
   * @expectedResult exchange:failed fires with RC5012 and the destination is skipped
   */
  test("directive without a principal fails with RC5012", async () => {
    const s = spy<string>();
    t = await testContext()
      .routes(
        craft()
          .id("anon-delegate")
          .from(simple("hello"))
          .delegate(() => ({ actor: zoeClaims }))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: {
      details: { error: unknown };
    }) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);
    await t.test();

    expect(s.received).toHaveLength(0);
    expect(String(failures[0])).toContain("RC5012");
  });
});
