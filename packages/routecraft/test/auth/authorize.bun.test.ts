import { afterEach, describe, expect, expectTypeOf, test } from "bun:test";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  authorize,
  craft,
  noop,
  simple,
  type EventName,
  type Principal,
  type Source,
} from "../../src/index.ts";

type FailedEventDetails = { details: { error: unknown } };

/**
 * Build a tiny test source that emits one body and forwards a principal
 * by writing it onto `headers["routecraft.auth.principal"]` before
 * invoking the handler. Mirrors what real authenticating sources
 * (e.g. `mcp({ auth: jwt(...) })`) do at their boundary, so the route's
 * first exchange already carries the principal and pre-from
 * `.authorize()` can gate it.
 */
function principalSource<T>(body: T, principal?: Principal): Source<T> {
  return {
    subscribe: async (_ctx, handler) => {
      const headers = principal
        ? { "routecraft.auth.principal": principal }
        : undefined;
      await handler(body, headers);
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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
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
    t.ctx.on(
      "route:anon:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
          .validate(authorize({ roles: ["admin"] }))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on(
      "route:rbac:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
          .validate(authorize({ roles: ["admin", "billing"] }))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on(
      "route:multi-role:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

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
   * @expectedResult exchange:failed fires with RC5015 mentioning "write"
   */
  test("rejects with RC5015 when a required scope is missing", async () => {
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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
          .validate(authorize({ scopes: ["read", "write"] }))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on(
      "route:scope:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(String(failures[0])).toContain("RC5015");
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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
          .validate(
            authorize({
              predicate: (p) => p.claims?.["tenant"] === "globex",
            }),
          )
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on(
      "route:predicate:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

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
    t.ctx.on(
      "route:pre-from-anon:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

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
    t.ctx.on(
      "route:short-circuit:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

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
    t.ctx.on(
      "route:recover:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

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
      craft()
        .id("post-from")
        .from(simple("hello"))
        .authorize({ roles: ["admin"] })
        .to(noop());
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
      craft()
        .id("enum")
        .from(simple("hello"))
        .authorize({ roles: ["admin"] })
        .to(noop()),
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
    const routes = t.ctx.getRoutes();
    const secondId = routes[1]?.definition.id ?? "";
    t.ctx.on(
      `route:${secondId}:exchange:failed` as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
          .validate(authorize())
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on(
      "route:exp-past:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("RC5020");
    expect(String(failures[0])).toContain("expired");
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
          .process((ex) => ({
            ...ex,
            headers: {
              ...ex.headers,
              "routecraft.auth.principal": principal,
            },
          }))
          .validate(authorize({ roles: ["admin"] }))
          .to(s),
      )
      .build();

    const failures: unknown[] = [];
    t.ctx.on(
      "route:exp-precedence:exchange:failed" as EventName,
      ((payload: FailedEventDetails) => {
        failures.push(payload.details.error);
      }) as Parameters<typeof t.ctx.on>[1],
    );

    await t.test();

    expect(failures).toHaveLength(1);
    const msg = String(failures[0]);
    expect(msg).toContain("RC5020");
    expect(msg).not.toContain("RC5015");
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
