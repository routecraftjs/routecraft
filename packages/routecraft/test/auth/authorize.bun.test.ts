import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  setSystemTime,
  test,
} from "bun:test";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  authenticate,
  authorize,
  craft,
  delegate,
  type InsufficientAuthority,
  markAuthentic,
  noop,
  simple,
  type Principal,
  type Source,
  type RouteBuilder,
} from "../../src/index.ts";
import { missingScopes } from "../../src/auth/authorize.ts";

type FailedEventDetails = { details: { error: unknown } };

/**
 * Build a tiny test source that emits one body and forwards a principal
 * by writing it onto `headers["routecraft.auth.principal"]` before
 * invoking the handler. Mirrors what real authenticating sources
 * (e.g. `mcp({ auth: jwt(...) })`) do at their boundary: the principal is
 * branded authentic with `markAuthentic` so the route's first exchange
 * carries a trusted identity and pre-from `.authorize()` can gate it.
 */
function principalSource<T>(body: T, principal?: Principal): Source<T> {
  return {
    subscribe: async (sub) => {
      const headers = principal
        ? { "routecraft.auth.principal": markAuthentic(principal) }
        : undefined;
      await sub.emit({ message: body, ...(headers ? { headers } : {}) });
    },
  };
}

describe("authorize() validator", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Validator returns body unchanged when an authenticated principal is present
   * @preconditions Route .process() attaches a principal then .validate(authorize()) runs
   * @expectedResult Spy destination receives the body, exchange.principal is preserved
   */
  test("passes through when principal is present", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
    };

    t = await testContext()
      .routes(
        craft()
          .id("ok")
          .from(simple("hello"))
          .authenticate(() => principal)
          .validate(authorize())
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello"]);
    expect(s.lastReceived().principal).toEqual(principal);
  });

  /**
   * @case Validator throws RC5012 when no principal is attached to the exchange
   * @preconditions Route uses .validate(authorize()) but never sets exchange.principal
   * @expectedResult exchange:failed event fires with an RC5012-coded error and the destination is skipped
   */
  test("rejects with RC5012 when no principal is present", async () => {
    const s = spy<string>();

    t = await testContext()
      .routes(
        craft().id("anon").from(simple("hello")).validate(authorize()).to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("RC5012");
  });

  /**
   * @case Validator throws RC5015 when the principal is missing a required role
   * @preconditions Principal has roles ["user"] but authorize() requires ["admin"]
   * @expectedResult exchange:failed fires with RC5015 mentioning the missing role
   */
  test("rejects with RC5015 when a required role is missing", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      roles: ["user"],
    };

    t = await testContext()
      .routes(
        craft()
          .id("rbac")
          .from(simple("hello"))
          .authenticate(() => principal)
          .validate(authorize({ roles: ["admin"] }))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("RC5015");
    expect(String(failures[0])).toContain("admin");
  });

  /**
   * @case All required roles must be present (AND-combined)
   * @preconditions Principal has ["admin"] but authorize() requires ["admin", "billing"]
   * @expectedResult exchange:failed fires with RC5015 listing the still-missing role
   */
  test("requires every listed role (AND)", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      roles: ["admin"],
    };

    t = await testContext()
      .routes(
        craft()
          .id("multi-role")
          .from(simple("hello"))
          .authenticate(() => principal)
          .validate(authorize({ roles: ["admin", "billing"] }))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(s.received).toHaveLength(0);
    // Anchor on the formatted "missing required role(s):" list rather than
    // bare substring matches: a future formatter change (e.g. " and " join)
    // shouldn't make this test pass for the wrong reason.
    const msg = String(failures[0]);
    const match = msg.match(
      /missing required role\(s\):\s*([^.\n]+?)(?:\.|\n|$)/,
    );
    const missing = match?.[1]?.trim().split(/\s*,\s*/) ?? [];
    expect(missing).toEqual(["billing"]);
  });

  /**
   * @case Required scopes are AND-combined and rejection cites the missing scope
   * @preconditions Principal has scope "read" but authorize() requires ["read", "write"]
   * @expectedResult exchange:failed fires with RC5038 (recoverable insufficiency, not RC5015) mentioning "write"
   */
  test("rejects with RC5038 when a required scope is missing", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      scopes: ["read"],
    };

    t = await testContext()
      .routes(
        craft()
          .id("scope")
          .from(simple("hello"))
          .authenticate(() => principal)
          .validate(authorize({ scopes: ["read", "write"] }))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(String(failures[0])).toContain("RC5038");
    expect(String(failures[0])).toContain("write");
  });

  /**
   * @case Custom predicate runs after role/scope checks and can reject
   * @preconditions Predicate returns false even though principal is otherwise valid
   * @expectedResult exchange:failed fires with RC5015
   */
  test("rejects when custom predicate returns false", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      claims: { tenant: "acme" },
    };

    t = await testContext()
      .routes(
        craft()
          .id("predicate")
          .from(simple("hello"))
          .authenticate(() => principal)
          .validate(
            authorize({
              predicate: (p) => p.claims?.["tenant"] === "globex",
            }),
          )
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(String(failures[0])).toContain("RC5015");
  });
});

describe(".authorize() route-only method", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Pre-from .authorize() gates the route at entry and lets a valid principal through
   * @preconditions Source emits a principal with role "admin"; pre-from .authorize() requires "admin"
   * @expectedResult Spy receives the body
   */
  test("pre-from .authorize() passes a principal that satisfies the requirement", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      roles: ["admin"],
    };

    t = await testContext()
      .routes(
        craft()
          .id("pre-from-ok")
          .authorize({ roles: ["admin"] })
          .from(principalSource("hello", principal))
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello"]);
  });

  /**
   * @case Pre-from .authorize() rejects when the source emits no principal
   * @preconditions Source emits no principal; pre-from .authorize() with no options
   * @expectedResult exchange:failed fires RC5012 and the destination is skipped
   */
  test("pre-from .authorize() rejects with RC5012 when source emits no principal", async () => {
    const s = spy<string>();

    t = await testContext()
      .routes(
        craft()
          .id("pre-from-anon")
          .authorize()
          .from(principalSource("hello"))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(String(failures[0])).toContain("RC5012");
  });

  /**
   * @case Multiple .authorize() calls stack and AND-combine before any pipeline step
   * @preconditions Two pre-from .authorize() calls (roles: admin, then scopes: read)
   *                run before .to(); principal satisfies both
   * @expectedResult Spy receives the body; both gates pass
   */
  test("stacks multiple .authorize() calls (AND-combined)", async () => {
    const s = spy<{ id: string }>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      roles: ["admin"],
      scopes: ["read", "write"],
    };

    t = await testContext()
      .routes(
        craft()
          .id("stack")
          .authorize({ roles: ["admin"] })
          .authorize({ scopes: ["read"] })
          .from(principalSource({ id: "x" }, principal))
          .to(s)
          .to(noop()),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual([{ id: "x" }]);
  });

  /**
   * @case Stacked .authorize() short-circuits at the first failure
   * @preconditions First .authorize() requires role "admin" (principal lacks it);
   *                second .authorize() has a predicate that would throw if invoked
   * @expectedResult exchange:failed fires with RC5015 from the first gate;
   *                 the second predicate never runs
   */
  test("stacked .authorize() short-circuits at the first failure", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      roles: ["user"],
    };
    let secondPredicateRan = false;

    t = await testContext()
      .routes(
        craft()
          .id("short-circuit")
          .authorize({ roles: ["admin"] })
          .authorize({
            predicate: () => {
              secondPredicateRan = true;
              return true;
            },
          })
          .from(principalSource("hello", principal))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(String(failures[0])).toContain("RC5015");
    expect(secondPredicateRan).toBe(false);
  });

  /**
   * @case Pre-from .authorize() runs before any user pipeline step
   * @preconditions Pre-from .authorize() rejects; .process() would mutate body if reached
   * @expectedResult Process step never runs; failure is reported
   */
  test("pre-from .authorize() runs before any user pipeline step", async () => {
    const s = spy<string>();
    let processRan = false;

    t = await testContext()
      .routes(
        craft()
          .id("entry-gate")
          .authorize()
          .from(principalSource("hello"))
          .process((ex) => {
            processRan = true;
            return ex;
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(processRan).toBe(false);
  });

  /**
   * @case Route-level .error() handler catches authorization failures
   * @preconditions Pre-from .error() handler is set; pre-from .authorize()
   *                rejects (no principal)
   * @expectedResult The handler is invoked with an RC5012 error and no
   *                 exchange:failed event fires (the route is recovered)
   */
  test("route-scope .error() handler catches an authorization failure", async () => {
    let handlerInvoked = 0;
    let errorSeen: unknown;

    t = await testContext()
      .routes(
        craft()
          .id("recover")
          .error((err) => {
            handlerInvoked++;
            errorSeen = err;
            return "fallback";
          })
          .authorize()
          .from(principalSource("hello")),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(handlerInvoked).toBe(1);
    expect(String(errorSeen)).toContain("RC5012");
    expect(failures).toHaveLength(0);
  });
});

describe(".authorize() positional rules", () => {
  /**
   * @case Mid-pipeline .authorize() (after .from(), before another .from()) is misuse
   *       and is caught by requireSource() on the next pipeline op
   * @preconditions craft().id().from(simple()).authorize().to(noop()) -- the .to()
   *                tries to push a step on the current route while .authorize()
   *                has already staged options for the next route
   * @expectedResult Throws RC2001 (structural). Message lists .authorize among the
   *                 staging ops that need .from() to follow.
   */
  test("throws RC2001 when a pipeline op follows a post-from .authorize()", () => {
    let caught: unknown;
    try {
      // Cast simulates a plain-JS caller: the PreFromBuilder typestate
      // rejects this at compile time, but the runtime guard must still fire.
      (
        craft()
          .id("post-from")
          .from(simple("hello"))
          .authorize({ roles: ["admin"] }) as unknown as RouteBuilder
      ).to(noop());
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ rc: "RC2001" });
  });

  /**
   * @case requireSource() RC2001 message enumerates .authorize alongside the other
   *       route-level staging ops so users discover the right fix
   * @preconditions As above; assert the message text lists .authorize
   * @expectedResult Thrown error message includes ".authorize"
   */
  test("RC2001 message enumerates .authorize as a staging op", () => {
    expect(() =>
      // Cast simulates a plain-JS caller (see above).
      (
        craft()
          .id("enum")
          .from(simple("hello"))
          .authorize({ roles: ["admin"] }) as unknown as RouteBuilder
      ).to(noop()),
    ).toThrow(/\.authorize/);
  });

  /**
   * @case .authorize() works pre-from for a chained second route after an earlier .from()
   * @preconditions craft().id(a).from(s1).to(d1).id(b).authorize().from(s2).to(d2)
   * @expectedResult Both routes build without throwing; the second route gates on
   *                 its own .authorize()
   */
  test("supports chained routes when staged via .id() before the next .from()", async () => {
    const t = await testContext()
      .routes(
        craft()
          .id("first")
          .from(simple("a"))
          .to(noop())
          .id("second")
          .authorize()
          .from(principalSource("b"))
          .to(noop()),
      )
      .build();

    expect(t.ctx.getRoutes()).toHaveLength(2);
    await t.stop();
  });

  /**
   * @case .authorize() can act as a route-starter just like .id() / .title() etc.,
   *       without requiring an explicit .id() between the previous route and the
   *       next .authorize().from(...) chain
   * @preconditions craft().id(a).from(s1).to(d1).authorize({roles:[admin]}).from(s2).to(d2)
   *                where s2 emits a principal with role "admin"
   * @expectedResult Both routes build; route 2's .authorize() gates its source.
   *                 Spy attached to route 2 receives the body, proving the
   *                 authorizer ran and accepted the principal.
   */
  test("acts as route-starter on its own (no preceding .id() required)", async () => {
    const main = spy<string>();
    const adminPrincipal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "admin-1",
      roles: ["admin"],
    };

    const t = await testContext()
      .routes(
        craft()
          .id("first")
          .from(simple("a"))
          .to(noop())
          .authorize({ roles: ["admin"] })
          .from(principalSource("b", adminPrincipal))
          .to(main),
      )
      .build();
    await t.test();

    expect(t.ctx.getRoutes()).toHaveLength(2);
    expect(main.receivedBodies()).toEqual(["b"]);
    await t.stop();
  });

  /**
   * @case Route-starter .authorize() rejects the route when the source emits no principal
   * @preconditions craft().id(a).from(s1).to(d1).authorize().from(s2).to(d2)
   *                where s2 emits no principal
   * @expectedResult Route 2's authorizer fires RC5012 and the destination is skipped;
   *                 route 1 is unaffected.
   */
  test("acts as route-starter and gates rejected requests", async () => {
    const main = spy<string>();

    const t = await testContext()
      .routes(
        craft()
          .id("first")
          .from(simple("a"))
          .to(noop())
          .authorize()
          .from(principalSource("b"))
          .to(main),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(main.received).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("RC5012");
    await t.stop();
  });
});

describe("exchange.principal propagation", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case A principal attached in .process() rides through to the destination
   * @preconditions .process() sets principal kind "custom"; downstream spy captures it
   * @expectedResult The spy receives an exchange whose principal matches what was set
   */
  test("custom principal set in .process() reaches the destination", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "email",
      subject: "ada@example.com",
      name: "Ada Lovelace",
    };

    t = await testContext()
      .routes(
        craft()
          .id("email-attribution")
          .from(simple("hello"))
          .authenticate(() => principal)
          .to(s),
      )
      .build();
    await t.test();

    expect(s.lastReceived().principal).toEqual(principal);
  });

  /**
   * @case Principal survives a transform step (transforms only touch body)
   * @preconditions .process() attaches principal, then .transform() rewrites body
   * @expectedResult Body is transformed but principal is unchanged at the destination
   */
  test("principal survives a body-only .transform()", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
    };

    t = await testContext()
      .routes(
        craft()
          .id("transform-keeps-principal")
          .from(simple("hello"))
          .authenticate(() => principal)
          .transform((body) => `${body}!`)
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello!"]);
    expect(s.lastReceived().principal).toEqual(principal);
  });

  /**
   * @case Source-emitted principal survives the route into the destination
   * @preconditions principalSource attaches a principal at the source boundary
   * @expectedResult The destination's exchange carries the same principal
   */
  test("source-emitted principal reaches the destination", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
    };

    t = await testContext()
      .routes(
        craft()
          .id("source-principal")
          .from(principalSource("hello", principal))
          .to(s),
      )
      .build();
    await t.test();

    expect(s.lastReceived().principal).toEqual(principal);
  });

  /**
   * @case Principal flows to a tap snapshot so taps see the same identity
   * @preconditions Route attaches principal then runs `.tap()` to a spy
   * @expectedResult Tap spy observes the same principal as the main flow
   */
  test("principal is included on tap snapshots", async () => {
    const main = spy<string>();
    const tapped = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
    };

    t = await testContext()
      .routes(
        craft()
          .id("tap-principal")
          .from(simple("hello"))
          .authenticate(() => principal)
          .tap(tapped)
          .to(main),
      )
      .build();
    await t.test();

    expect(main.lastReceived().principal).toEqual(principal);
    expect(tapped.lastReceived().principal).toEqual(principal);
  });

  /**
   * @case Tap snapshots share structured-header values (like `principal.claims`)
   *       by reference with the main flow. With the unified state model
   *       (`{ body, headers }` is the serialization surface; cross-cutting
   *       concerns live in `headers` like anything else), the framework no
   *       longer deep-clones principal into tap snapshots. Nested mutation
   *       of structured header values is an anti-pattern the framework
   *       does not prevent or isolate against; routes that need a fresh
   *       identity should set a new principal on `headers` rather than
   *       mutating the existing one. This test pins that contract so a
   *       future PR cannot silently re-introduce the deep-clone.
   *       See `.standards/exchange-state-model.md`.
   * @preconditions Route attaches a principal with mutable `claims`, taps,
   *                then mutates `principal.claims.tenant` in a downstream
   *                `.process()` step
   * @expectedResult Both the tap snapshot and the main-flow exchange see
   *                 the post-mutation `claims.tenant` value (shared by
   *                 reference; no isolation)
   */
  test("tap snapshot shares principal claims by reference (no deep-clone)", async () => {
    const main = spy<string>();
    const tapped = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      claims: { tenant: "before" },
    };

    t = await testContext()
      .routes(
        craft()
          .id("tap-principal-shared-ref")
          .from(simple("hello"))
          .authenticate(() => principal)
          .tap(tapped)
          .process((ex) => {
            // Anti-pattern (and the test's whole point): the framework
            // does not isolate nested mutations of structured header
            // values. The mutation leaks into the tap snapshot because
            // they share the same `principal` object reference.
            (ex.principal!.claims as { tenant: string }).tenant = "after";
            return ex;
          })
          .to(main),
      )
      .build();
    await t.test();

    expect(
      (main.lastReceived().principal!.claims as { tenant: string }).tenant,
    ).toBe("after");
    expect(
      (tapped.lastReceived().principal!.claims as { tenant: string }).tenant,
    ).toBe("after");
  });
});

describe("authorize() expiresAt enforcement", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Validator passes through when principal.expiresAt is in the future
   * @preconditions Principal has expiresAt = now + 60s
   * @expectedResult Spy destination receives the body; no RC5020 fires
   */
  test("passes through when expiresAt is in the future", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    };

    t = await testContext()
      .routes(
        craft()
          .id("exp-future")
          .from(simple("hello"))
          .authenticate(() => principal)
          .validate(authorize())
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello"]);
  });

  /**
   * @case Validator passes through when principal carries no expiresAt
   * @preconditions Principal has no expiresAt field (custom auth, opaque token)
   * @expectedResult Spy destination receives the body; no RC5020 fires
   */
  test("passes through when expiresAt is absent", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
    };

    t = await testContext()
      .routes(
        craft()
          .id("exp-absent")
          .from(simple("hello"))
          .authenticate(() => principal)
          .validate(authorize())
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello"]);
  });

  /**
   * @case Validator throws RC5020 when principal.expiresAt is in the past
   * @preconditions Principal has expiresAt = now - 60s (mid-pipeline expiry)
   * @expectedResult exchange:failed fires with RC5020; destination is skipped
   */
  test("rejects with RC5020 when expiresAt has passed", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    };

    t = await testContext()
      .routes(
        craft()
          .id("exp-past")
          .from(simple("hello"))
          .authenticate(() => principal)
          .validate(authorize())
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("RC5020");
    expect(String(failures[0])).toContain("expired");
  });

  /**
   * @case clockToleranceSec admits a token whose expiresAt is within tolerance
   * @preconditions Principal expiresAt is now - 2s; authorize({ clockToleranceSec: 5 })
   * @expectedResult Validator passes through; matches the boundary-side clock tolerance
   */
  test("clockToleranceSec admits a token within tolerance", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      expiresAt: Math.floor(Date.now() / 1000) - 2,
    };

    t = await testContext()
      .routes(
        craft()
          .id("exp-tolerated")
          .from(simple("hello"))
          .authenticate(() => principal)
          .validate(authorize({ clockToleranceSec: 5 }))
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello"]);
  });

  /**
   * @case A token whose expiry equals the current second is already expired
   * @preconditions System clock pinned to the middle of a second; principal expiresAt equals that floored second; no clock tolerance
   * @expectedResult Refused with RC5020. RFC 7519 section 4.1.4 requires the current time to be before `exp`, and jose rejects on `exp <= now - tolerance`, so the comparison is inclusive; an exclusive `>` would honour the token for a further second
   */
  test("refuses a token at the exact expiry second", async () => {
    const second = 1_800_000_000;
    setSystemTime(new Date(second * 1000 + 500));
    try {
      const s = spy<string>();
      const principal: Principal = {
        kind: "custom",
        scheme: "bearer",
        subject: "user-1",
        expiresAt: second,
      };

      t = await testContext()
        .routes(
          craft()
            .id("exp-exact-second")
            .from(simple("hello"))
            .authenticate(() => principal)
            .validate(authorize({}))
            .to(s),
        )
        .build();
      await t.test();

      expect(s.receivedBodies()).toEqual([]);
    } finally {
      setSystemTime();
    }
  });

  /**
   * @case A fractional expiry later in the current second is still valid
   * @preconditions System clock pinned to 1_800_000_000.900; principal expiresAt is 1_800_000_000.5; no clock tolerance
   * @expectedResult Admitted. `now` is floored to whole seconds exactly as jose floors it via `epoch(new Date())`, so the comparison is 1_800_000_000 >= 1_800_000_000.5, which is false. An unfloored `now` would reject a token jose accepts
   */
  test("floors now to whole seconds, matching jose, for a fractional expiry", async () => {
    const second = 1_800_000_000;
    setSystemTime(new Date(second * 1000 + 900));
    try {
      const s = spy<string>();
      const principal: Principal = {
        kind: "custom",
        scheme: "bearer",
        subject: "user-1",
        expiresAt: second + 0.5,
      };

      t = await testContext()
        .routes(
          craft()
            .id("exp-fractional")
            .from(simple("hello"))
            .authenticate(() => principal)
            .validate(authorize({}))
            .to(s),
        )
        .build();
      await t.test();

      expect(s.receivedBodies()).toEqual(["hello"]);
    } finally {
      setSystemTime();
    }
  });

  /**
   * @case clockToleranceSec still rejects when expiresAt is past the tolerance window
   * @preconditions Principal expiresAt is now - 60s; authorize({ clockToleranceSec: 5 })
   * @expectedResult exchange:failed fires with RC5020
   */
  test("clockToleranceSec still rejects past the tolerance window", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    };

    t = await testContext()
      .routes(
        craft()
          .id("exp-beyond-tolerance")
          .from(simple("hello"))
          .authenticate(() => principal)
          .validate(authorize({ clockToleranceSec: 5 }))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("RC5020");
  });

  /**
   * @case Non-finite expiresAt fails closed (does not silently bypass the check)
   * @preconditions Principal expiresAt is NaN (e.g. attached by a buggy .process() step)
   * @expectedResult RC5020 fires; NaN cannot mask the guard
   */
  test("non-finite expiresAt fails closed with RC5020", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      expiresAt: Number.NaN,
    };

    t = await testContext()
      .routes(
        craft()
          .id("exp-nan")
          .from(simple("hello"))
          .authenticate(() => principal)
          .validate(authorize())
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("RC5020");
  });

  /**
   * @case RC5020 is distinct from RC5012 (no principal) and RC5015 (wrong roles)
   * @preconditions Expired principal also lacks a required role
   * @expectedResult RC5020 wins (expiry check runs before role check)
   */
  test("RC5020 fires before role / scope checks when expired", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      roles: ["user"],
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    };

    t = await testContext()
      .routes(
        craft()
          .id("exp-precedence")
          .from(simple("hello"))
          .authenticate(() => principal)
          .validate(authorize({ roles: ["admin"] }))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ((payload: FailedEventDetails) => {
      failures.push(payload.details.error);
    }) as Parameters<typeof t.ctx.on>[1]);

    await t.test();

    expect(failures).toHaveLength(1);
    const msg = String(failures[0]);
    expect(msg).toContain("RC5020");
    expect(msg).not.toContain("RC5015");
  });
});

describe("authorize() anyScope", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /** What `options` threw for `principal`, or undefined when it passed. */
  function refusalOf(
    options: Parameters<typeof authorize>[0],
    principal: Principal,
  ): unknown {
    const check = authorize(options);
    try {
      check({ body: "x", principal } as unknown as Parameters<typeof check>[0]);
      return undefined;
    } catch (err) {
      return err;
    }
  }

  /** The `missing` detail a refusal carries for a consent flow to act on. */
  function missingFromCause(
    refusal: unknown,
  ): InsufficientAuthority["missing"] | undefined {
    return (refusal as { cause?: InsufficientAuthority }).cause?.missing;
  }

  const family = ["leave:read", "leave:read:self", "leave:read:base"];

  /**
   * @case A route declaring anyScope admits a principal holding one variant
   * @preconditions Pre-from .authorize({ anyScope }) naming three interchangeable variants; principal holds the middle one only
   * @expectedResult The exchange reaches the destination, so the OR is wired through the route-entry guard and not only through the validator
   */
  test("admits a principal holding one of the accepted scopes", async () => {
    const s = spy<string>();

    t = await testContext()
      .routes(
        craft()
          .id("any-scope")
          .from(simple("hello"))
          .authenticate(() => ({
            subject: "user-1",
            scopes: ["leave:read:self"],
          }))
          .validate(authorize({ anyScope: family }))
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello"]);
  });

  /**
   * @case An anyScope refusal names the whole accepted set, not one entry
   * @preconditions Principal holds an unrelated scope; authorize() accepts any of three variants
   * @expectedResult RC5038 whose cause carries every accepted scope on missing.scopes, so a consent flow can offer the caller the choice
   */
  test("refuses with RC5038 naming every accepted scope", () => {
    const principal = authenticate({
      subject: "user-1",
      scopes: ["leave:write"],
    });

    const refusal = refusalOf({ anyScope: family }, principal);

    expect(String(refusal)).toContain("RC5038");
    expect(missingFromCause(refusal)).toEqual({ scopes: family, mode: "any" });
    for (const scope of family) expect(String(refusal)).toContain(scope);
  });

  /**
   * @case scopes and anyScope compose as an AND of the two conditions
   * @preconditions Route requires scopes ["leave:list"] AND any of the read family; principal built three ways
   * @expectedResult Passes only when both hold; each half alone is refused with RC5038 naming what that half wanted
   */
  test("ANDs the two conditions when both are given", () => {
    const options = { scopes: ["leave:list"], anyScope: family };
    const holder = (scopes: string[]) =>
      authenticate({ subject: "user-1", scopes });

    expect(
      refusalOf(options, holder(["leave:list", "leave:read:base"])),
    ).toBeUndefined();

    const noAnd = refusalOf(options, holder(["leave:read:base"]));
    expect(String(noAnd)).toContain("RC5038");
    expect(missingFromCause(noAnd)).toEqual({
      scopes: ["leave:list"],
      mode: "all",
    });

    const noOr = refusalOf(options, holder(["leave:list"]));
    expect(String(noOr)).toContain("RC5038");
    expect(missingFromCause(noOr)).toEqual({ scopes: family, mode: "any" });
  });

  /**
   * @case An empty accepted set is refused when the validator is built
   * @preconditions authorize({ anyScope: [] }), the shape a tenant lookup that missed or an unset environment variable produces
   * @expectedResult RC2001 at construction, before any request. An empty any-of list is satisfiable by nobody, so reading it as no check would remove a route's only scope gate in silence, where the empty AND list next to it is a requirement of nothing and stays vacuously satisfied
   */
  test("refuses an empty accepted set when the validator is built", () => {
    let caught: unknown;
    try {
      authorize({ anyScope: [] });
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain("RC2001");

    const principal = authenticate({ subject: "user-1" });
    expect(refusalOf({ scopes: [] }, principal)).toBeUndefined();
  });

  /**
   * @case Holding more than one of the accepted scopes still admits
   * @preconditions Principal holds two of the three accepted variants
   * @expectedResult Admitted. The check is "at least one", never "exactly one", so a caller whose grant grew cannot be locked out by it
   */
  test("admits a principal holding several of the accepted scopes", () => {
    const principal = authenticate({
      subject: "user-1",
      scopes: ["leave:read", "leave:read:self"],
    });

    expect(refusalOf({ anyScope: family }, principal)).toBeUndefined();
  });

  /**
   * @case Identity checks still win before either new option is consulted
   * @preconditions A self-asserted (never minted) principal that WOULD satisfy an anyScope + effective check on its scopes
   * @expectedResult RC5023, not RC5038 or an admission: the new options widen what counts as sufficient authority, never what counts as an authentic identity
   */
  test("rejects a self-asserted principal before reading any scope", () => {
    const selfAsserted = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      scopes: ["leave:read"],
    } as Principal;

    const refusal = refusalOf(
      { anyScope: family, effective: true, actor: "any" },
      selfAsserted,
    );
    expect(String(refusal)).toContain("RC5023");
  });

  /**
   * @case missingScopes keeps AND semantics and reads the subject's ring only
   * @preconditions The shared helper called with two required scopes of which one is held, then with a delegated principal whose actor holds the absent scope
   * @expectedResult Both absent entries are reported and the actor's ring is ignored, which is what the scope-gated ops tier at plugins/ops/tier.ts depends on
   */
  test("missingScopes stays an AND over the subject's own scopes", () => {
    const principal = authenticate({
      subject: "user-1",
      scopes: ["ops:introspection"],
    });

    expect(
      missingScopes(principal, ["ops:introspection", "ops:dispatch"]),
    ).toEqual(["ops:dispatch"]);
    expect(missingScopes(principal, ["ops:introspection"])).toEqual([]);

    const delegated = delegate(principal, {
      subject: "agent:zoe",
      scopes: ["ops:dispatch"],
    });
    expect(missingScopes(delegated, ["ops:dispatch"])).toEqual([
      "ops:dispatch",
    ]);
  });
});

describe(".authorize() type checks", () => {
  /**
   * @case Pre-from .authorize() preserves the body type that .from() introduces
   * @preconditions craft().authorize().from<T>(source) chained with a typed .to()
   * @expectedResult The builder's exchange-body type after .from() equals T,
   *                 so a typed .to() compiles
   */
  test("pre-from .authorize() does not perturb body inference", () => {
    const built = craft()
      .id("typed-route")
      .authorize({ roles: ["admin"] })
      .from(principalSource({ id: "x" } as { id: string }));

    // After .from<{id: string}>, the builder's Current generic must be
    // {id: string} so a downstream .to(spy<{id:string}>()) type-checks.
    expectTypeOf(built.to).toBeCallableWith(spy<{ id: string }>());
  });
});
