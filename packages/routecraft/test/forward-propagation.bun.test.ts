import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  getExchangeRoute,
  HeadersKeys,
  markAuthentic,
  markRestored,
  simple,
  type Exchange,
  type Principal,
  type Source,
} from "../src/index.ts";

/**
 * Source that emits one body carrying a principal the way an authenticating
 * source does: written onto `headers["routecraft.auth.principal"]` and
 * branded via the supplied marker, so the route's first exchange carries a
 * trusted (or deliberately restored) identity.
 */
function principalSource<T>(
  body: T,
  principal?: Principal,
  mark: (p: Principal) => Principal = markAuthentic,
): Source<T> {
  return {
    subscribe: async (sub) => {
      const headers = principal
        ? { [HeadersKeys.AUTH_PRINCIPAL]: mark(principal) }
        : undefined;
      await sub.emit({ message: body, ...(headers ? { headers } : {}) });
    },
  };
}

const principal: Principal = {
  kind: "custom",
  scheme: "bearer",
  subject: "user-1",
  scopes: ["kb:read"],
};

/** Forward to `endpoint` from inside a `.transform()`, via the bound route. */
function forwardFrom(endpoint: string) {
  return async (_body: unknown, ex: Exchange<unknown>): Promise<unknown> => {
    const forward = getExchangeRoute(ex)?.getForward(ex);
    return forward?.(endpoint as never, {});
  };
}

describe("forward() header propagation", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case forward() carries the caller's principal into a target guarded by .authorize()
   * @preconditions Caller route runs under an authentic principal and forwards to a route declaring .authorize()
   * @expectedResult The target completes and observed the caller's subject, with no RC5012
   */
  test("carries the caller's principal through .authorize()", async () => {
    let seenSubject: string | undefined;

    t = await testContext()
      .routes([
        craft()
          .id("guarded")
          .authorize({ scopes: ["kb:read"] })
          .from(direct())
          .transform((_b: unknown, ex: Exchange<unknown>) => {
            seenSubject = ex.principal?.subject;
            return { ok: true };
          }),
        craft()
          .id("caller")
          .from(principalSource("go", principal))
          .transform(forwardFrom("guarded")),
      ])
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ({ details }) => {
      failures.push(details.error);
    });

    await t.test();

    expect(failures).toHaveLength(0);
    expect(seenSubject).toBe("user-1");
  });

  /**
   * @case forward() keeps the caller's correlation id so the trace stays one logical request
   * @preconditions Caller forwards to a target; both record their correlation id header
   * @expectedResult Target's correlation id equals the caller's
   */
  test("keeps the caller's correlation id", async () => {
    let callerCorrelationId: unknown;
    let targetCorrelationId: unknown;

    t = await testContext()
      .routes([
        craft()
          .id("target")
          .from(direct())
          .transform((_b: unknown, ex: Exchange<unknown>) => {
            targetCorrelationId = ex.headers[HeadersKeys.CORRELATION_ID];
            return { ok: true };
          }),
        craft()
          .id("caller")
          .from(principalSource("go", principal))
          .transform(async (body: unknown, ex: Exchange<unknown>) => {
            callerCorrelationId = ex.headers[HeadersKeys.CORRELATION_ID];
            return forwardFrom("target")(body, ex);
          }),
      ])
      .build();
    await t.test();

    expect(targetCorrelationId).toBe(callerCorrelationId);
    expect(targetCorrelationId).toBeDefined();
  });

  /**
   * @case An anonymous caller forwards anonymously rather than acquiring an identity
   * @preconditions Caller route has no principal and forwards to a target that records ex.principal
   * @expectedResult Target sees no principal; forward never fabricates one
   */
  test("does not fabricate a principal for an anonymous caller", async () => {
    let sawPrincipal: boolean | undefined;

    t = await testContext()
      .routes([
        craft()
          .id("target-anon")
          .from(direct())
          .transform((_b: unknown, ex: Exchange<unknown>) => {
            sawPrincipal = ex.principal !== undefined;
            return { ok: true };
          }),
        craft()
          .id("caller-anon")
          .from(simple("go"))
          .transform(forwardFrom("target-anon")),
      ])
      .build();
    await t.test();

    expect(sawPrincipal).toBe(false);
  });

  /**
   * @case A restored principal stays restored across a forward instead of being laundered or downgraded
   * @preconditions Caller carries a principal branded with markRestored; target declares .authorize()
   * @expectedResult Target rejects with RC5043 (restored), never RC5023 (self-asserted) and never passes
   */
  test("forwards a restored principal as restored (RC5043)", async () => {
    let reached = false;

    t = await testContext()
      .routes([
        craft()
          .id("guarded-restored")
          .authorize({ scopes: ["kb:read"] })
          .from(direct())
          .transform(() => {
            reached = true;
            return { ok: true };
          }),
        craft()
          .id("caller-restored")
          .from(principalSource("go", principal, markRestored))
          .transform(forwardFrom("guarded-restored")),
      ])
      .build();

    const failures: unknown[] = [];
    t.ctx.on("route:exchange:failed", ({ details }) => {
      failures.push(details.error);
    });

    await t.test();

    expect(reached).toBe(false);
    const codes = failures.map(String).join("\n");
    expect(codes).toContain("RC5043");
    expect(codes).not.toContain("RC5023");
  });

  /**
   * @case The caller's split hierarchy does not ride along to the forwarded route
   * @preconditions A split child forwards to another route, which records its split-hierarchy header
   * @expectedResult Target sees no split hierarchy, so it cannot claim the caller's split parent
   */
  test("does not forward the caller's split hierarchy", async () => {
    let callerHadHierarchy = false;
    const targetHierarchies: unknown[] = [];

    t = await testContext()
      .routes([
        craft()
          .id("target-split")
          .from(direct())
          .transform((_b: unknown, ex: Exchange<unknown>) => {
            targetHierarchies.push(ex.headers[HeadersKeys.SPLIT_HIERARCHY]);
            return { ok: true };
          }),
        craft()
          .id("caller-split")
          .from(simple([{ id: 1 }, { id: 2 }]))
          .split()
          .transform(async (body: unknown, ex: Exchange<unknown>) => {
            if (ex.headers[HeadersKeys.SPLIT_HIERARCHY]) {
              callerHadHierarchy = true;
            }
            return forwardFrom("target-split")(body, ex);
          }),
      ])
      .build();
    await t.test();

    expect(callerHadHierarchy).toBe(true);
    expect(targetHierarchies.length).toBeGreaterThan(0);
    for (const h of targetHierarchies) expect(h).toBeUndefined();
  });

  /**
   * @case A forwarded exchange gets its own id rather than inheriting the caller's
   * @preconditions Caller forwards to a target; both record ex.id and correlation id
   * @expectedResult Ids differ (stores keyed by exchange id do not collide) while the correlation id still matches
   */
  test("mints a fresh exchange id while keeping the correlation id", async () => {
    let callerId: string | undefined;
    let targetId: string | undefined;
    let callerCorrelationId: unknown;
    let targetCorrelationId: unknown;

    t = await testContext()
      .routes([
        craft()
          .id("target-id")
          .from(direct())
          .transform((_b: unknown, ex: Exchange<unknown>) => {
            targetId = ex.id;
            targetCorrelationId = ex.headers[HeadersKeys.CORRELATION_ID];
            return { ok: true };
          }),
        craft()
          .id("caller-id")
          .from(principalSource("go", principal))
          .transform(async (body: unknown, ex: Exchange<unknown>) => {
            callerId = ex.id;
            callerCorrelationId = ex.headers[HeadersKeys.CORRELATION_ID];
            return forwardFrom("target-id")(body, ex);
          }),
      ])
      .build();
    await t.test();

    expect(targetId).toBeDefined();
    expect(targetId).not.toBe(callerId);
    expect(targetCorrelationId).toBe(callerCorrelationId);
  });

  /**
   * @case A circuitBreaker fallback's forward carries the caller's identity
   * @preconditions Breaker trips, its fallback forwards to a route declaring .authorize()
   * @expectedResult The fallback target completes and saw the caller's subject
   */
  test("circuitBreaker fallback forwards with the caller's principal", async () => {
    let fallbackSubject: string | undefined;

    t = await testContext()
      .routes([
        craft()
          .id("cb-recovery")
          .authorize({ scopes: ["kb:read"] })
          .from(direct())
          .transform((_b: unknown, ex: Exchange<unknown>) => {
            fallbackSubject = ex.principal?.subject;
            return { recovered: true };
          }),
        craft()
          .id("cb-caller")
          .from(direct())
          .circuitBreaker({
            failureThreshold: 1,
            cooldown: 10_000,
            fallback: (_ex, forward) => forward("cb-recovery" as never, {}),
          })
          .transform(() => {
            throw new Error("downstream down");
          }),
      ])
      .build();

    await t.startAndWaitReady();
    const headers = { [HeadersKeys.AUTH_PRINCIPAL]: markAuthentic(principal) };
    // First call fails and trips the breaker; the second meets it open and
    // takes the fallback, which is the path under test.
    await expect(
      t.client.sendDirect("cb-caller", "a", headers),
    ).rejects.toThrow();
    await t.client.sendDirect("cb-caller", "b", headers);

    expect(fallbackSubject).toBe("user-1");
  });

  /**
   * @case A direct() destination invoked from a split child does not leak the hierarchy
   * @preconditions Split children each call a direct() destination that records the split header
   * @expectedResult The target sees no split hierarchy, so it cannot claim the caller's split parent
   */
  test("does not leak the split hierarchy through to(direct())", async () => {
    const targetHierarchies: unknown[] = [];

    t = await testContext()
      .routes([
        craft()
          .id("target-direct-split")
          .from(direct())
          .transform((_b: unknown, ex: Exchange<unknown>) => {
            targetHierarchies.push(ex.headers[HeadersKeys.SPLIT_HIERARCHY]);
            return { ok: true };
          }),
        craft()
          .id("caller-direct-split")
          .from(simple([{ id: 1 }, { id: 2 }]))
          .split()
          .to(direct("target-direct-split")),
      ])
      .build();
    await t.test();

    expect(targetHierarchies.length).toBeGreaterThan(0);
    for (const h of targetHierarchies) expect(h).toBeUndefined();
  });

  /**
   * @case A route-scope .error() handler's forward carries the caller's identity
   * @preconditions Route runs under a principal, a step throws, and .error() forwards to a guarded route
   * @expectedResult The guarded recovery route completes and saw the caller's subject
   */
  test("route-scope .error() forwards with the caller's principal", async () => {
    let recoverySubject: string | undefined;

    t = await testContext()
      .routes([
        craft()
          .id("recovery")
          .authorize({ scopes: ["kb:read"] })
          .from(direct())
          .transform((_b: unknown, ex: Exchange<unknown>) => {
            recoverySubject = ex.principal?.subject;
            return { recovered: true };
          }),
        craft()
          .id("failing")
          .error((_err, _ex, forward) => forward("recovery" as never, {}))
          .from(principalSource("go", principal))
          .transform(() => {
            throw new Error("boom");
          }),
      ])
      .build();
    await t.test();

    expect(recoverySubject).toBe("user-1");
  });
});
