import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  MemorySuspensionStore,
  SUSPENSION_RUNTIME,
  craft,
  direct,
  isSuspended,
  log,
  noop,
  otherwise,
  simple,
  when,
  type CraftConfig,
  type EventName,
  type Exchange,
  type Suspended,
} from "../src/index.ts";

/**
 * A signing secret for the two-context tests, which share one store across
 * a simulated redeploy and therefore need tokens that survive it. The
 * 32-byte floor is enforced, so this is deliberately long.
 */
const SECRET = "suspend-resume-test-secret-key-0123456789";

const Approval = z.object({
  approved: z.boolean(),
  note: z.string().optional(),
});

interface Payout {
  amountCents: number;
  payee: string;
}

/**
 * A context whose suspension runtime is the in-memory backend with an
 * ephemeral signing key. `testContext()` substitutes both as soon as a
 * `suspension` block is present, so every suspending test declares one.
 */
function suspending(): { suspension: Record<string, never> } & CraftConfig {
  return { suspension: {} } as {
    suspension: Record<string, never>;
  } & CraftConfig;
}

/** Read the acknowledgment execution one answered with. */
function asSuspended(value: unknown): Suspended {
  expect(isSuspended(value)).toBe(true);
  return value as Suspended;
}

describe("suspend and resume", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A route parks at .suspend() and answers execution one with the Suspended acknowledgment
   * @preconditions direct() ingress, one .suspend({ expect }), a sink after it
   * @expectedResult The caller receives a branded Suspended value carrying the suspension id, a token and the expect rendering; the steps after the suspend have not run
   */
  test("suspend parks the exchange and answers with an acknowledgment", async () => {
    const after: unknown[] = [];
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ expect: Approval })
          .tap((ex) => {
            after.push(ex.body);
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const answer = await t.client.sendDirect("payout", {
      amountCents: 90_000,
      payee: "acme",
    });

    const suspended = asSuspended(answer);
    expect(suspended.status).toBe("suspended");
    expect(suspended.suspensionId).toBeString();
    expect(suspended.token).toBeString();
    expect(suspended.expect).toBeDefined();
    expect(after).toHaveLength(0);
  });

  /**
   * @case A resume revives the parked exchange at position N+1 with the answer in place
   * @preconditions A parked payout, and a second route ending in .resume() fed by its own direct() ingress
   * @expectedResult Only the steps after the suspend run, ex.suspension.result carries the validated answer, and the acknowledgment reports the continuation's terminal outcome
   */
  test("resume runs the continuation with ex.suspension.result populated", async () => {
    const ran: Array<{ body: unknown; approved: boolean }> = [];
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ expect: Approval })
          .tap((ex) => {
            ran.push({
              body: ex.body,
              approved: ex.suspension.result.approved,
            });
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", {
        amountCents: 90_000,
        payee: "acme",
      }),
    );

    const acknowledgment = await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true, note: "ok" },
    });

    expect(acknowledgment).toMatchObject({
      status: "resumed",
      routeId: "payout",
      suspensionId: parked.suspensionId,
    });
    expect(ran).toHaveLength(1);
    expect(ran[0]?.approved).toBe(true);
    // The body crossed the park untouched, which is what lets a suspend
    // branch rejoin the main flow on the contract it left on.
    expect(ran[0]?.body).toEqual({ amountCents: 90_000, payee: "acme" });
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A duplicate resume returns the cached terminal outcome instead of re-running the continuation
   * @preconditions A suspension already resumed once; the same token presented again
   * @expectedResult The second call reports status "duplicate" with the first run's outcome, and the continuation ran exactly once
   */
  test("a duplicate resume is idempotent", async () => {
    let runs = 0;
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ expect: Approval })
          .transform((body) => {
            runs++;
            return { paid: (body as Payout).amountCents };
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", {
        amountCents: 25_000,
        payee: "acme",
      }),
    );
    const first = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string; body?: unknown } };
    const second = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string; body?: unknown } };

    expect(first.status).toBe("resumed");
    expect(second.status).toBe("duplicate");
    expect(second.outcome.status).toBe("completed");
    expect(second.outcome.body).toEqual(first.outcome.body);
    expect(runs).toBe(1);
  });

  /**
   * @case The continuation changed under a parked exchange
   * @preconditions The exchange parks in one context; a second context runs the same route with an edited step after the suspend point, sharing the store
   * @expectedResult The resume is refused with RC5048 before any continuation step runs, the ingress caller sees the error, and the suspended route's .error() handler receives it
   */
  test("a changed continuation re-enters the route error channel with RC5048", async () => {
    const store = new MemorySuspensionStore();
    const shared = {
      suspension: { store, secret: SECRET },
    } as unknown as CraftConfig;

    const parkContext = await testContext()
      .with(shared)
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ expect: Approval })
          .transform((body) => ({ paid: (body as Payout).amountCents }))
          .to(noop()),
      ])
      .build();
    await parkContext.startAndWaitReady();
    const parked = asSuspended(
      await parkContext.client.sendDirect("payout", {
        amountCents: 25_000,
        payee: "acme",
      }),
    );
    await parkContext.stop();

    const caught: unknown[] = [];
    const paid: unknown[] = [];
    t = await testContext()
      .with(shared)
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            caught.push(err);
            return { reasked: true };
          })
          .from(direct())
          .suspend({ expect: Approval })
          // The edit: the tail now pays a different amount than the one
          // the approver was shown.
          .transform((body) => ({ paid: (body as Payout).amountCents * 2 }))
          .tap((ex) => {
            paid.push(ex.body);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("answers", {
        token: parked.token,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5048" });

    expect(paid).toHaveLength(0);
    expect(caught).toHaveLength(1);
    expect(caught[0]).toMatchObject({ rc: "RC5048" });
  });

  /**
   * @case An answer that does not satisfy the suspending step's expect schema
   * @preconditions A parked payout; the resume presents { approved: "yes" }
   * @expectedResult RC5049 in the ingress route, nothing after the suspend runs, and the suspension stays resumable so a corrected answer still works
   */
  test("an answer that fails expect is refused with RC5049 and leaves the suspension resumable", async () => {
    const ran: unknown[] = [];
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ expect: Approval })
          .tap((ex) => {
            ran.push(ex.suspension.result);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", {
        amountCents: 10,
        payee: "acme",
      }),
    );

    await expect(
      t.client.sendDirect("answers", {
        token: parked.token,
        result: { approved: "yes" },
      }),
    ).rejects.toMatchObject({ rc: "RC5049" });
    expect(ran).toHaveLength(0);

    const acknowledgment = await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    });
    expect(acknowledgment).toMatchObject({ status: "resumed" });
    expect(ran).toHaveLength(1);
  });

  /**
   * @case A resume arriving after the suspension's ttl elapsed
   * @preconditions .suspend({ ttl: "1ms" }); the answer is presented after the deadline
   * @expectedResult RC5047 in the ingress route, route:exchange:expired on the registry, and the suspended route's .error() handler sees it so it can re-ask
   */
  test("an expired suspension refuses the answer with RC5047", async () => {
    const caught: unknown[] = [];
    const expired: unknown[] = [];
    t = await testContext()
      .with(suspending())
      .on(
        "route:exchange:expired" as EventName,
        ((payload: { details: unknown }) => {
          expired.push(payload.details);
        }) as never,
      )
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            caught.push(err);
            return { reasked: true };
          })
          .from(direct())
          .suspend({ expect: Approval, ttl: "1ms" })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    expect(parked.expiresAt).toBeString();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(
      t.client.sendDirect("answers", {
        token: parked.token,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5047" });

    expect(expired).toHaveLength(1);
    expect(caught).toHaveLength(1);
    expect(caught[0]).toMatchObject({ rc: "RC5047" });
  });

  /**
   * @case A forged or unknown resume token
   * @preconditions A token this deployment never minted, and a well-formed token naming no stored suspension
   * @expectedResult RC5041 for the forgery and RC5046 for the unknown id, both in the ingress route
   */
  test("a forged token is RC5041 and an unknown suspension is RC5046", async () => {
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ expect: Approval })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("answers", {
        token: "not-a-token.at-all",
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5041" });

    const runtime = t.ctx.getStore(SUSPENSION_RUNTIME);
    const orphan = runtime!.signer.mint("no-such-suspension~0");
    await expect(
      t.client.sendDirect("answers", {
        token: orphan,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5046" });
  });

  /**
   * @case The route keeps serving other exchanges while one is parked
   * @preconditions One exchange parked at a suspend inside a .choice() branch; a second exchange takes the fast path while it is parked
   * @expectedResult The second exchange completes normally and the parked one still resumes afterwards, proving nothing waits on the route
   */
  test("a parked exchange does not block the route", async () => {
    const completed: unknown[] = [];
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from<Payout>(direct())
          .choice(
            when<Payout>(
              (ex) => ex.body.amountCents >= 50_000,
              (b) => b
                .suspend({ expect: Approval })
                .filter((ex) =>
                  ex.suspension.result.approved ? true : { reason: "rejected" },
                ),
            ),
            otherwise((b) => b),
          )
          .tap((ex) => {
            completed.push(ex.body);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", {
        amountCents: 90_000,
        payee: "big",
      }),
    );
    // The route is still live: this one never touches the suspend branch.
    const fast = await t.client.sendDirect("payout", {
      amountCents: 100,
      payee: "small",
    });
    expect(isSuspended(fast)).toBe(false);
    expect(completed).toEqual([{ amountCents: 100, payee: "small" }]);

    await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    });
    // The approved payout rejoined the main flow behind the fast one, on
    // the same contract: the branch restored the body it was handed.
    expect(completed).toEqual([
      { amountCents: 100, payee: "small" },
      { amountCents: 90_000, payee: "big" },
    ]);
  });

  /**
   * @case A rejected verdict is consumed inside the suspend branch
   * @preconditions The branch ends in .filter() reading ex.suspension.result; the answer is a rejection
   * @expectedResult The exchange is dropped inside the branch and never reaches the main flow's steps
   */
  test("a rejected verdict drops the exchange inside the branch", async () => {
    const paid: unknown[] = [];
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from<Payout>(direct())
          .choice(
            when<Payout>(
              (ex) => ex.body.amountCents >= 50_000,
              (b) => b.suspend({ expect: Approval }).filter((ex) =>
                ex.suspension.result.approved
                  ? true
                  : {
                      reason: `rejected by ${ex.suspension.resumedBy?.subject ?? "anonymous"}`,
                    },
              ),
            ),
            otherwise((b) => b),
          )
          .tap((ex) => {
            paid.push(ex.body);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", {
        amountCents: 90_000,
        payee: "big",
      }),
    );
    const acknowledgment = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: false },
    })) as { outcome: { status: string } };

    expect(acknowledgment.outcome.status).toBe("dropped");
    expect(paid).toHaveLength(0);
  });

  /**
   * @case The suspension token is readable before the suspend step runs
   * @preconditions A .tap() ahead of the .suspend() reads ex.suspension.token and ex.suspension.id
   * @expectedResult The values it read are the ones the eventual acknowledgment carries, so a notification sent before the park contains a working link
   */
  test("ex.suspension.token is mintable before the suspend step", async () => {
    const notified: Array<{ id: string; token: string }> = [];
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .tap((ex) => {
            notified.push({
              id: ex.suspension.id,
              token: ex.suspension.token,
            });
          })
          .suspend({ expect: Approval })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    await t.drain();

    expect(notified).toHaveLength(1);
    expect(notified[0]?.id).toBe(parked.suspensionId);
    // Tokens are minted per call, so compare what they resolve to rather
    // than the strings: what matters is that the early one resumes.
    const acknowledgment = await t.client.sendDirect("answers", {
      token: notified[0]!.token,
      result: { approved: true },
    });
    expect(acknowledgment).toMatchObject({ status: "resumed" });
  });

  /**
   * @case Suspension lifecycle events land on the fixed event registry
   * @preconditions A park and a resume observed through ctx.on()
   * @expectedResult route:exchange:suspended carries the suspension id and position and replaces :completed for execution one; route:exchange:resumed precedes execution two's :started / :completed
   */
  test("suspended and resumed events fire on the fixed registry", async () => {
    const seen: string[] = [];
    const details: Record<string, unknown[]> = {
      suspended: [],
      resumed: [],
    };
    const record = (name: string) =>
      ((payload: { details: unknown }) => {
        seen.push(name);
        details[name]?.push(payload.details);
      }) as never;

    t = await testContext()
      .with(suspending())
      .on("route:exchange:suspended" as EventName, record("suspended"))
      .on("route:exchange:resumed" as EventName, record("resumed"))
      .on("route:exchange:completed" as EventName, record("completed"))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ expect: Approval })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    expect(seen.filter((name) => name === "suspended")).toHaveLength(1);
    expect(details["suspended"]?.[0]).toMatchObject({
      routeId: "payout",
      suspensionId: parked.suspensionId,
      position: 0,
    });

    await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    });
    expect(details["resumed"]?.[0]).toMatchObject({
      routeId: "payout",
      suspensionId: parked.suspensionId,
    });
    expect(seen.indexOf("resumed")).toBeLessThan(seen.lastIndexOf("completed"));
  });

  /**
   * @case An exchange holding a value that cannot be persisted
   * @preconditions A step puts a function on the body before the suspend
   * @expectedResult The suspend fails with RC5042 at park time (not at resume), naming the offending path, and the exchange never reaches the store
   */
  test("suspend refuses an exchange that cannot be persisted", async () => {
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .transform(() => ({ callback: () => "nope" }))
          .suspend({ expect: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    ).rejects.toMatchObject({ rc: "RC5042" });
  });

  /**
   * @case A route that can suspend runs in a context with no suspension config
   * @preconditions No `suspension` block on the context
   * @expectedResult context.start() refuses with RC5052 rather than parking into a store nobody chose
   */
  test("starting a suspendable route without a suspension runtime is RC5052", async () => {
    // Deliberately not assigned to `t`: the context never starts, so there
    // is nothing to tear down, and `TestContext.stop()` re-throws a failed
    // start.
    const unconfigured = await testContext()
      .routes([
        craft()
          .id("payout")
          .from(simple({ amountCents: 1 }))
          .suspend({ expect: Approval })
          .to(log()),
      ])
      .build();

    await expect(unconfigured.ctx.start()).rejects.toMatchObject({
      rc: "RC5052",
    });
  });

  /**
   * @case .suspend() inside an unbalanced .split()
   * @preconditions A route that splits an array and suspends per child
   * @expectedResult craft().build() refuses with RC5051 rather than parking children nothing can aggregate
   */
  test("suspend inside .split() is refused at build time", () => {
    expect(() =>
      craft()
        .id("bulk")
        .from(direct())
        .split()
        .suspend({ expect: Approval })
        .to(noop())
        .build(),
    ).toThrow(expect.objectContaining({ rc: "RC5051" }) as unknown as Error);
  });

  /**
   * @case .suspend() inside a .multicast() path
   * @preconditions A route that fans out and suspends inside one path
   * @expectedResult craft().build() refuses with RC5051: a path exchange is an isolated side flow with nowhere to rejoin
   */
  test("suspend inside a .multicast() path is refused at build time", () => {
    expect(() =>
      craft()
        .id("fanout")
        .from(direct())
        .multicast((b) => b.suspend({ expect: Approval }).to(noop()))
        .to(noop())
        .build(),
    ).toThrow(expect.objectContaining({ rc: "RC5051" }) as unknown as Error);
  });

  /**
   * @case A step-scope wrapper around .suspend()
   * @preconditions .retry() staged immediately before a .suspend()
   * @expectedResult The wrapper refuses at construction (RC5003): parking is not a failure to re-attempt, and a wrapped park has no coherent recovery
   */
  test("a step-scope wrapper cannot wrap .suspend()", () => {
    expect(() =>
      craft()
        .id("payout")
        .from(direct())
        .retry()
        .suspend({ expect: Approval })
        .to(noop()),
    ).toThrow(expect.objectContaining({ rc: "RC5003" }) as unknown as Error);
  });

  /**
   * @case The expect schema types ex.suspension.result downstream of the suspend
   * @preconditions A chain whose suspend declares a zod object schema
   * @expectedResult The narrowed field is readable without a cast, and stays unknown before any suspend (compile-time assertion; the runtime body is incidental)
   */
  test("expect threads its type into ex.suspension.result", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("typed")
          .from(direct())
          .tap((ex: Exchange<unknown>) => {
            const before: unknown = ex.suspension.result;
            seen.push(typeof before);
          })
          .suspend({ expect: Approval })
          .tap((ex) => {
            // No cast: `approved` is boolean because `expect` said so.
            const approved: boolean = ex.suspension.result.approved;
            seen.push(String(approved));
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("typed", { amountCents: 1, payee: "acme" }),
    );
    await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    });
    await t.drain();

    expect(seen).toEqual(["undefined", "true"]);
  });
});
