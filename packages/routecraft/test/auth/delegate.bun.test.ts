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
  markAuthentic,
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
   * @case Scopes intersect the subject with the consent ceiling; roles pass through
   * @preconditions Subject has [mail:send, employees:read]; ceiling is [mail:send, kb:read]
   * @expectedResult Effective scopes are exactly [mail:send]; subject roles untouched and the actor's own roles stay on the actor
   */
  test("intersects subject scopes with the ceiling and passes roles through", () => {
    const delegated = delegate(jaco(), zoeClaims, {
      scopes: ["mail:send", "kb:read"],
    });

    expect(delegated.scopes).toEqual(["mail:send"]);
    expect(delegated.roles).toEqual(["member", "admin"]);
    expect(delegated.actor?.roles).toEqual(["agent"]);
  });

  /**
   * @case A user can delegate authority the agent does not hold standalone
   * @preconditions Agent identity carries only read scopes; the subject holds kb:write and grants it
   * @expectedResult The delegated principal carries kb:write. The actor's own scopes are not a term, so an agent that must never write on its own can still be granted write on a user's behalf (the shared system-account case)
   */
  test("grants authority the actor lacks on its own identity", () => {
    const readOnlyAgent: PrincipalClaims = {
      subject: "agent:zoe",
      subjectProfile: "ai_agent",
      issuer: EYWA_ISS,
      scopes: ["kb:read"],
    };
    const subject = jaco({ scopes: ["kb:read", "kb:write"] });

    const delegated = delegate(subject, readOnlyAgent, {
      scopes: ["kb:write"],
    });

    expect(delegated.scopes).toEqual(["kb:write"]);
    expect(delegated.actor?.scopes).toEqual(["kb:read"]);
  });

  /**
   * @case The consent ceiling still cannot exceed what the subject holds
   * @preconditions Subject holds only kb:read; the ceiling asks for kb:write as well
   * @expectedResult Only kb:read survives, so removing the actor's scopes from the intersection did not create a widening path
   */
  test("ceiling cannot exceed the subject's own scopes", () => {
    const subject = jaco({ scopes: ["kb:read"] });
    const delegated = delegate(subject, zoeClaims, {
      scopes: ["kb:read", "kb:write"],
    });

    expect(delegated.scopes).toEqual(["kb:read"]);
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

  /**
   * @case A re-delegation without its own grantId does not inherit the prior hop's
   * @preconditions First hop carries grantId "grant_1"; second hop passes no grantId
   * @expectedResult The second principal has no grantId, so the new hop is not misattributed to the earlier consent record
   */
  test("clears a stale grantId on re-delegation", () => {
    const first = delegate(jaco(), zoeClaims, { grantId: "grant_1" });
    const second = delegate(first, {
      subject: "agent:max",
      subjectProfile: "ai_agent",
      issuer: EYWA_ISS,
    });

    expect(second.grantId).toBeUndefined();
  });
});

describe("delegation state cannot be forged", () => {
  /**
   * @case authenticate() refuses to mint delegation state
   * @preconditions Claims carry an actor, or a grantId, as a spread of an already-delegated principal would
   * @expectedResult RC5024 in both cases, so re-minting cannot bypass delegate()'s mayAct check and scope intersection
   */
  test("authenticate() rejects actor and grantId claims", () => {
    const delegated = delegate(jaco(), zoeClaims);
    expect(
      thrownString(() => authenticate(delegated as unknown as PrincipalClaims)),
    ).toContain("RC5024");
    expect(
      thrownString(() =>
        authenticate({
          subject: "user_jaco",
          grantId: "grant_forged",
        } as unknown as PrincipalClaims),
      ),
    ).toContain("RC5024");
  });

  /**
   * @case mayAct is still accepted by authenticate(), since it describes the subject
   * @preconditions Claims carry mayAct, as a directory-sourced consent policy would
   * @expectedResult Mint succeeds and the restriction is enforced by a later delegate()
   */
  test("authenticate() still accepts mayAct", () => {
    const principal = authenticate({
      subject: "user_jaco",
      mayAct: [{ subject: "agent:zoe", issuer: EYWA_ISS }],
    });
    expect(principal.mayAct).toHaveLength(1);
    expect(
      thrownString(() => delegate(principal, { subject: "agent:evil" })),
    ).toContain("RC5037");
  });

  /**
   * @case The actor chain and mayAct of an authentic principal cannot be mutated in place
   * @preconditions Authentic principal carrying a two-hop chain and a mayAct entry
   * @expectedResult Rewriting the current actor, a nested actor, or pushing to mayAct all throw, so a holder of ex.principal cannot rewrite policy inputs
   */
  test("freezes the chain and the consent list", () => {
    const withConsent = authenticate({
      subject: "user_jaco",
      scopes: ["mail:send"],
      mayAct: [
        { subject: "agent:zoe", issuer: EYWA_ISS },
        { subject: "agent:max", issuer: EYWA_ISS },
      ],
    });
    const chained = delegate(delegate(withConsent, zoeClaims), {
      subject: "agent:max",
      issuer: EYWA_ISS,
    });

    expect(() => {
      (chained.actor as { subject: string }).subject = "agent:superuser";
    }).toThrow(TypeError);
    expect(() => {
      (chained.actor!.actor as { subject: string }).subject = "agent:ghost";
    }).toThrow(TypeError);
    expect(() => {
      chained.mayAct?.push({ subject: "agent:evil" });
    }).toThrow(TypeError);
  });

  /**
   * @case The subject's own policy arrays are frozen on any authentic principal
   * @preconditions Plain authenticate() mint carrying roles and scopes
   * @expectedResult Pushing onto principal.roles or principal.scopes throws, so a holder of ex.principal cannot escalate an authentic identity in place
   */
  test("freezes the subject's own roles and scopes", () => {
    const principal = authenticate({
      subject: "user_jaco",
      roles: ["member"],
      scopes: ["kb:read"],
    });

    expect(() => {
      (principal.roles as string[]).push("admin");
    }).toThrow(TypeError);
    expect(() => {
      (principal.scopes as string[]).push("payroll:read");
    }).toThrow(TypeError);
  });

  /**
   * @case mayAct rides on the subject, so it also gates re-delegation
   * @preconditions Subject permits only agent:zoe; the chain tries to hand off from zoe to max
   * @expectedResult RC5037 at the second hop, making re-delegation non-transitive without any extra mechanism
   */
  test("mayAct gates every hop, not just the first", () => {
    const withConsent = authenticate({
      subject: "user_jaco",
      mayAct: [{ subject: "agent:zoe", issuer: EYWA_ISS }],
    });
    const viaZoe = delegate(withConsent, zoeClaims);

    expect(
      thrownString(() =>
        delegate(viaZoe, { subject: "agent:max", issuer: EYWA_ISS }),
      ),
    ).toContain("RC5037");
  });

  /**
   * @case Actor claims cannot smuggle in delegation state
   * @preconditions Actor claims carry their own nested actor entries and a grantId (cast past the type)
   * @expectedResult Both are stripped: the chain is exactly one hop deep naming only the real actor, and grant attribution comes solely from options.grantId (absent here)
   */
  test("strips a forged chain and grantId from the actor claims", () => {
    const forged = {
      subject: "agent:max",
      issuer: EYWA_ISS,
      actor: { subject: "agent:ghost", actor: { subject: "agent:ghost2" } },
      grantId: "grant_forged",
    } as unknown as PrincipalClaims;
    const delegated = delegate(jaco(), forged);

    expect(delegated.actor?.subject).toBe("agent:max");
    expect(delegated.actor?.actor).toBeUndefined();
    expect(delegated.grantId).toBeUndefined();
    expect(delegated.actor?.grantId).toBeUndefined();
  });

  /**
   * @case markAuthentic freezes its own copy, never the caller's structures
   * @preconditions A shared actor object and roles array passed into markAuthentic (the trusted adapter-author path)
   * @expectedResult The returned principal's delegation state is frozen clones; the caller's objects stay unfrozen and later caller mutation does not leak into the authentic principal
   */
  test("markAuthentic clones instead of freezing caller structures", () => {
    const sharedActor: Principal = {
      kind: "custom",
      scheme: "custom",
      subject: "agent:zoe",
    };
    const sharedRoles = ["member"];
    const principal = markAuthentic({
      kind: "custom",
      scheme: "custom",
      subject: "user_jaco",
      roles: sharedRoles,
      actor: sharedActor,
    } as Principal);

    expect(Object.isFrozen(sharedActor)).toBe(false);
    expect(Object.isFrozen(sharedRoles)).toBe(false);
    sharedActor.subject = "agent:changed";
    sharedRoles.push("admin");
    expect(principal.actor?.subject).toBe("agent:zoe");
    expect(principal.roles).toEqual(["member"]);
    expect(Object.isFrozen(principal.actor)).toBe(true);
    expect(Object.isFrozen(principal.roles)).toBe(true);
  });

  /**
   * @case A cyclic actor chain is bounded rather than hanging the check
   * @preconditions Hand-assembled self-referential chain reached through a cast
   * @expectedResult authorize() rejects with RC5036 promptly instead of walking the cycle forever
   */
  test("bounds a cyclic chain instead of spinning", () => {
    const cyclic: Principal = {
      kind: "custom",
      scheme: "custom",
      subject: "agent:loop",
    };
    (cyclic as { actor?: Principal }).actor = cyclic;
    const principal = markAuthentic({
      kind: "custom",
      scheme: "custom",
      subject: "user_jaco",
      actor: cyclic,
    } as Principal);

    const check = authorize({ actor: "any" });
    expect(
      thrownString(() =>
        check({ body: "x", principal } as unknown as Parameters<
          typeof check
        >[0]),
      ),
    ).toContain("RC5036");
  });
});

describe("authorize() delegation awareness", () => {
  type FailedEventDetails = { details: { error: unknown } };

  /**
   * Chain of actors to apply, outermost last: `[zoe]` is one hop,
   * `[zoe, max]` is zoe handing off to max. Built with real `.delegate()`
   * steps so the route under test sees a principal assembled exactly the
   * way production assembles one (`.authenticate()` refuses pre-delegated
   * claims by design, so a chain cannot be smuggled in via the mint).
   */
  type Hops = PrincipalClaims[];

  async function run(
    hops: Hops,
    options: Parameters<typeof authorize>[0],
    subjectClaims: PrincipalClaims = {
      subject: "user_jaco",
      subjectProfile: "user",
      issuer: "https://idp.example.com",
      roles: ["member", "admin"],
      scopes: ["mail:send", "employees:read"],
    },
    ceiling?: string[],
  ): Promise<{ delivered: number; failure: string }> {
    const s = spy<string>();
    let builder = craft()
      .id("delegation")
      .from(simple("hello"))
      .authenticate(() => subjectClaims);
    for (const hop of hops) {
      builder = builder.delegate(() => ({
        actor: hop,
        ...(ceiling ? { scopes: ceiling } : {}),
      }));
    }
    const t = await testContext()
      .routes(builder.validate(authorize(options)).to(s))
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

  const maxClaims: PrincipalClaims = {
    subject: "agent:max",
    subjectProfile: "ai_agent",
    issuer: EYWA_ISS,
  };
  const direct: Hops = [];
  const viaZoe: Hops = [zoeClaims];
  const viaMaxViaZoe: Hops = [zoeClaims, maxClaims];

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

    const ok = await run(
      direct,
      { subject: { profile: "ai_agent" } },
      {
        subject: "agent:zoe",
        subjectProfile: "ai_agent",
        issuer: EYWA_ISS,
        roles: ["agent"],
      },
    );
    expect(ok.delivered).toBe(1);
  });

  /**
   * @case Subject matcher gates on subject id and issuer, not only profile
   * @preconditions Route pins subject "user_jaco" at the IdP issuer
   * @expectedResult The matching caller passes; a different subject and a same-subject-different-issuer caller both raise RC5035
   */
  test("subject matcher pins id and issuer", async () => {
    const spec = {
      subject: { subject: "user_jaco", issuer: "https://idp.example.com" },
    };
    expect((await run(direct, spec)).delivered).toBe(1);

    const otherSubject = await run(direct, spec, {
      subject: "user_other",
      issuer: "https://idp.example.com",
    });
    expect(otherSubject.failure).toContain("RC5035");

    const otherIssuer = await run(direct, spec, {
      subject: "user_jaco",
      issuer: "https://evil.example.com",
    });
    expect(otherIssuer.failure).toContain("RC5035");
  });

  /**
   * @case A subject predicate receives the full principal
   * @preconditions Predicate requires an email on the internal domain
   * @expectedResult Matching caller passes; non-matching raises RC5035
   */
  test("supports a predicate subject spec", async () => {
    const spec = {
      subject: (p: Principal) => p.email?.endsWith("@example.com") === true,
    };
    const ok = await run(direct, spec, {
      subject: "user_jaco",
      email: "jaco@example.com",
    });
    expect(ok.delivered).toBe(1);

    const nope = await run(direct, spec, {
      subject: "user_jaco",
      email: "jaco@elsewhere.test",
    });
    expect(nope.failure).toContain("RC5035");
  });

  /**
   * @case maxDelegationDepth of 0 rejects any delegation while leaving direct calls alone
   * @preconditions actor 'any' with maxDelegationDepth 0
   * @expectedResult One hop raises RC5036; a direct call still passes
   */
  test("maxDelegationDepth 0 forbids every hop", async () => {
    const spec = { actor: "any" as const, maxDelegationDepth: 0 };
    const hop = await run(viaZoe, spec);
    expect(hop.delivered).toBe(0);
    expect(hop.failure).toContain("RC5036");
    expect((await run(direct, spec)).delivered).toBe(1);
  });

  /**
   * @case A non-finite maxDelegationDepth fails closed
   * @preconditions actor 'any' with maxDelegationDepth NaN (e.g. Number of an unset env var); one delegation hop
   * @expectedResult RC5036, because depth > NaN is always false and would otherwise accept a chain of any depth; direct calls are unaffected since the depth check only runs when an actor is present
   */
  test("non-finite maxDelegationDepth rejects delegation with RC5036", async () => {
    const spec = { actor: "any" as const, maxDelegationDepth: Number.NaN };
    const hop = await run(viaZoe, spec);
    expect(hop.delivered).toBe(0);
    expect(hop.failure).toContain("RC5036");
    expect((await run(direct, spec)).delivered).toBe(1);
  });

  /**
   * @case Roles check the subject even when an actor drives; scopes check the narrowed set
   * @preconditions Delegation with ceiling [mail:send]; route requires roles [member] and scopes [employees:read]
   * @expectedResult Role check passes (subject attribute), scope check fails RC5038 (intersected away)
   */
  test("roles pass through delegation while scopes narrow", async () => {
    const res = await run(
      viaZoe,
      { roles: ["member"], scopes: ["employees:read"], actor: "any" },
      undefined,
      ["mail:send"],
    );
    expect(res.delivered).toBe(0);
    expect(res.failure).toContain("RC5038");
    expect(res.failure).toContain("employees:read");
  });

  /**
   * @case RC5038 carries a machine-readable list of the missing scopes
   * @preconditions Route requires two scopes the principal lacks
   * @expectedResult error.cause.missing.scopes lists exactly the absent scopes, so a consent flow can request them
   */
  test("RC5038 exposes missing.scopes on the cause", () => {
    const principal = authenticate({
      subject: "user_jaco",
      scopes: ["mail:draft"],
    });
    const check = authorize({ scopes: ["mail:send", "employees:read"] });
    let caught: unknown;
    try {
      check({ body: "x", principal } as unknown as Parameters<typeof check>[0]);
    } catch (err) {
      caught = err;
    }
    const cause = (caught as { cause?: { missing?: { scopes?: string[] } } })
      .cause;
    expect(cause?.missing?.scopes).toEqual(["mail:send", "employees:read"]);
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
