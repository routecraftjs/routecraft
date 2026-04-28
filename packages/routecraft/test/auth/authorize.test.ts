import { describe, test, expect, expectTypeOf, afterEach } from "vitest";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  noop,
  requirePrincipal,
  simple,
  type EventName,
  type Principal,
} from "../../src/index.ts";

type FailedEventDetails = { details: { error: unknown } };

describe("requirePrincipal()", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Validator returns body unchanged when an authenticated principal is present
   * @preconditions Route .process() attaches a custom principal then .authorize() runs
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
          .process((ex) => {
            ex.principal = principal;
            return ex;
          })
          .authorize()
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello"]);
    expect(s.lastReceived().principal).toEqual(principal);
  });

  /**
   * @case Validator throws RC5012 when no principal is attached to the exchange
   * @preconditions Route uses .authorize() but never sets exchange.principal
   * @expectedResult exchange:failed event fires with an RC5012-coded error and the destination is skipped
   */
  test("rejects with RC5012 when no principal is present", async () => {
    const s = spy<string>();

    t = await testContext()
      .routes(craft().id("anon").from(simple("hello")).authorize().to(s))
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
   * @preconditions Principal has roles ["user"] but .authorize() requires ["admin"]
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
          .process((ex) => {
            ex.principal = principal;
            return ex;
          })
          .authorize({ roles: ["admin"] })
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
   * @preconditions Principal has ["admin"] but .authorize() requires ["admin", "billing"]
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
          .process((ex) => {
            ex.principal = principal;
            return ex;
          })
          .authorize({ roles: ["admin", "billing"] })
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
   * @preconditions Principal has scope "read" but .authorize() requires ["read", "write"]
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
          .process((ex) => {
            ex.principal = principal;
            return ex;
          })
          .authorize({ scopes: ["read", "write"] })
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
          .process((ex) => {
            ex.principal = principal;
            return ex;
          })
          .authorize({
            predicate: (p) => p.claims?.["tenant"] === "globex",
          })
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

  /**
   * @case requirePrincipal as a plain validator works with .validate()
   * @preconditions Route uses .validate(requirePrincipal({ roles: ["admin"] }))
   * @expectedResult Authorized exchange flows through; unauthorized fails RC5015
   */
  test("requirePrincipal composes via .validate()", async () => {
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
          .id("compose")
          .from(simple("hello"))
          .process((ex) => {
            ex.principal = principal;
            return ex;
          })
          .validate(requirePrincipal({ roles: ["admin"] }))
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello"]);
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
          .process((ex) => {
            ex.principal = principal;
            return ex;
          })
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
          .process((ex) => {
            ex.principal = principal;
            return ex;
          })
          .transform((body) => `${body}!`)
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello!"]);
    expect(s.lastReceived().principal).toEqual(principal);
  });

  /**
   * @case `.authorize()` without options succeeds for any authenticated principal
   * @preconditions Principal has no roles or scopes; .authorize() called without options
   * @expectedResult Exchange flows through to the destination
   */
  test(".authorize() without options accepts any principal", async () => {
    const s = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
    };

    t = await testContext()
      .routes(
        craft()
          .id("any-auth")
          .from(simple("hello"))
          .process((ex) => {
            ex.principal = principal;
            return ex;
          })
          .authorize()
          .to(s),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual(["hello"]);
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
          .process((ex) => {
            ex.principal = principal;
            return ex;
          })
          .tap(tapped)
          .to(main),
      )
      .build();
    await t.test();

    expect(main.lastReceived().principal).toEqual(principal);
    expect(tapped.lastReceived().principal).toEqual(principal);
  });

  /**
   * @case Tap snapshot principal is deep-cloned, not shared by reference,
   *       so concurrent mutation of one side does not leak to the other
   * @preconditions Route attaches a principal whose `claims` is a mutable
   *                object, taps to a spy, mutates the main exchange's
   *                principal in a downstream `.process()`
   * @expectedResult The tap spy's captured principal still carries the
   *                 original `claims` value (unaffected by the mutation)
   */
  test("tap snapshot principal is isolated from main flow mutations", async () => {
    const main = spy<string>();
    const tapped = spy<string>();
    const principal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "user-1",
      claims: { tenant: "acme", flags: ["original"] },
    };

    t = await testContext()
      .routes(
        craft()
          .id("tap-principal-isolation")
          .from(simple("hello"))
          .process((ex) => {
            ex.principal = principal;
            return ex;
          })
          .tap(tapped)
          .process((ex) => {
            // Mutate the live principal AFTER tap has snapshotted it.
            // If the snapshot shares the principal by reference, the tap
            // spy will observe these mutations.
            (ex.principal!.claims as Record<string, unknown>)["tenant"] =
              "globex";
            (ex.principal!.claims as { flags: string[] }).flags.push("mutated");
            return ex;
          })
          .to(main),
      )
      .build();
    await t.test();

    // Tap snapshot must reflect the principal AT SNAPSHOT TIME, not the
    // post-mutation state of the main flow.
    expect(tapped.lastReceived().principal?.claims).toEqual({
      tenant: "acme",
      flags: ["original"],
    });
    // Main flow saw the mutation (sanity check that the test actually
    // mutated something).
    expect(main.lastReceived().principal?.claims).toEqual({
      tenant: "globex",
      flags: ["original", "mutated"],
    });
  });
});

describe(".authorize() type checks", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case .authorize() is type-preserving (body type unchanged) on RouteBuilder
   * @preconditions Build a route with .authorize() between a typed source and destination
   * @expectedResult The builder's exchange-body type remains the source's body type
   *                 across .authorize() calls; chained .to() compiles
   */
  test("is body-type-preserving on RouteBuilder (type-level)", () => {
    const beforeAuthorize = craft()
      .id("typed-route")
      .from(simple({ id: "x" } as { id: string }))
      .process((ex) => {
        ex.principal = {
          kind: "custom",
          scheme: "bearer",
          subject: "user-1",
        };
        return ex;
      });

    const afterAuthorize = beforeAuthorize.authorize({ roles: ["admin"] });

    // .authorize() is a validate-style sugar declared as `(opts?) => this`.
    // The builder type returned must equal the type before .authorize()
    // (same Current generic, same subclass), so chained operators that
    // depend on body inference (.to(spy<{id:string}>())) keep typing.
    expectTypeOf(afterAuthorize).toEqualTypeOf(beforeAuthorize);
  });

  /**
   * @case .authorize() chains alongside .to() without changing body inference
   * @preconditions Multi-step route with two .authorize() calls and a typed spy
   * @expectedResult Spy receives body { id: "x" } at runtime
   */
  test("is type-preserving and chainable", async () => {
    const s = spy<{ id: string }>();

    t = await testContext()
      .routes(
        craft()
          .id("chain")
          .from(simple({ id: "x" }))
          .process((ex) => {
            ex.principal = {
              kind: "custom",
              scheme: "bearer",
              subject: "user-1",
              roles: ["admin"],
              scopes: ["read", "write"],
            };
            return ex;
          })
          .authorize({ roles: ["admin"] })
          .authorize({ scopes: ["read"] })
          .to(s)
          .to(noop()),
      )
      .build();
    await t.test();

    expect(s.receivedBodies()).toEqual([{ id: "x" }]);
  });
});
