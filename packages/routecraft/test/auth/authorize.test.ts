import { describe, test, expect, afterEach } from "vitest";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  noop,
  requirePrincipal,
  simple,
  type Principal,
} from "../../src/index.ts";

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
    t.ctx.on("route:anon:exchange:failed" as any, (payload: any) => {
      failures.push(payload.details.error);
    });

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
    t.ctx.on("route:rbac:exchange:failed" as any, (payload: any) => {
      failures.push(payload.details.error);
    });

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
    t.ctx.on("route:multi-role:exchange:failed" as any, (payload: any) => {
      failures.push(payload.details.error);
    });

    await t.test();

    expect(s.received).toHaveLength(0);
    expect(String(failures[0])).toContain("billing");
    expect(String(failures[0])).not.toContain("admin,");
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
    t.ctx.on("route:scope:exchange:failed" as any, (payload: any) => {
      failures.push(payload.details.error);
    });

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
    t.ctx.on("route:predicate:exchange:failed" as any, (payload: any) => {
      failures.push(payload.details.error);
    });

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
});

describe(".authorize() type checks", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case .authorize() is type-preserving (chainable on any builder)
   * @preconditions Build a route with multiple .authorize() calls and a typed destination
   * @expectedResult Chain compiles and runs without altering body type
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
