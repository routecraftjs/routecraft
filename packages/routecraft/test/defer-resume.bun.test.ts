import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  MemoryDeferralStore,
  DEFERRAL_RUNTIME,
  authorize,
  craft,
  direct,
  isDeferred,
  log,
  noop,
  otherwise,
  simple,
  when,
  type CraftConfig,
  type EventName,
  type Exchange,
} from "../src/index.ts";
import { asDeferred, storeWith, deferring } from "./helpers/deferral.ts";

/**
 * A signing secret for the two-context tests, which share one store across
 * a simulated redeploy and therefore need tokens that survive it. The
 * 32-byte floor is enforced, so this is deliberately long.
 */
const SECRET = "defer-resume-test-secret-key-0123456789";

const Approval = z.object({
  approved: z.boolean(),
  note: z.string().optional(),
});

interface Payout {
  amountCents: number;
  payee: string;
}

describe("defer and resume", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A route parks at .defer() and answers execution one with the Deferred acknowledgment
   * @preconditions direct() ingress, one .defer({ expect }), a sink after it
   * @expectedResult The caller receives a branded Deferred value carrying the deferral id, a token and the expect rendering; the steps after the defer have not run
   */
  test("defer parks the exchange and answers with an acknowledgment", async () => {
    const after: unknown[] = [];
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
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

    const deferred = asDeferred(answer);
    expect(deferred.status).toBe("deferred");
    expect(deferred.deferralId).toBeString();
    expect(deferred.token).toBeString();
    expect(deferred.schema).toBeDefined();
    expect(after).toHaveLength(0);
  });

  /**
   * @case A resume revives the parked exchange at position N+1 with the answer in place
   * @preconditions A parked payout, and a second route ending in .resume() fed by its own direct() ingress
   * @expectedResult Only the steps after the defer run, ex.deferral.result carries the validated answer, and the acknowledgment reports the continuation's terminal outcome
   */
  test("resume runs the continuation with ex.deferral.result populated", async () => {
    const ran: Array<{ body: unknown; approved: boolean }> = [];
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .tap((ex) => {
            ran.push({
              body: ex.body,
              approved: ex.deferral.result.approved,
            });
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
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
      deferralId: parked.deferralId,
    });
    expect(ran).toHaveLength(1);
    expect(ran[0]?.approved).toBe(true);
    // The body crossed the park untouched, which is what lets a defer
    // branch rejoin the main flow on the contract it left on.
    expect(ran[0]?.body).toEqual({ amountCents: 90_000, payee: "acme" });
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A duplicate resume returns the cached terminal outcome instead of re-running the continuation
   * @preconditions A deferral already resumed once; the same token presented again
   * @expectedResult The second call reports status "duplicate" with the first run's outcome, and the continuation ran exactly once
   */
  test("a duplicate resume is idempotent", async () => {
    let runs = 0;
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .transform((body) => {
            runs++;
            return { paid: (body as Payout).amountCents };
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
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
   * @preconditions The exchange parks in one context; a second context runs the same route with an edited step after the defer point, sharing the store
   * @expectedResult The resume is refused with RC5048 before any continuation step runs, the ingress caller sees the error, and the deferred route's .error() handler receives it
   */
  test("a changed continuation re-enters the route error channel with RC5048", async () => {
    const store = new MemoryDeferralStore();
    const shared: CraftConfig = {
      deferral: { store, secret: SECRET },
    };

    const parkContext = await testContext()
      .with(shared)
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .transform((body) => ({ paid: (body as Payout).amountCents }))
          .to(noop()),
      ])
      .build();
    await parkContext.startAndWaitReady();
    const parked = asDeferred(
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
          .defer({ schema: Approval })
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
   * @case An answer that does not satisfy the deferring step's expect schema
   * @preconditions A parked payout; the resume presents { approved: "yes" }
   * @expectedResult RC5049 in the ingress route ONLY (the deferred route's own .error() never sees it), nothing after the defer runs, and the deferral stays resumable so a corrected answer completes normally
   */
  test("an answer that fails expect is refused with RC5049 and leaves the deferral resumable", async () => {
    const ran: unknown[] = [];
    const caught: unknown[] = [];
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          // The deferred route must NOT see a malformed answer: it is a
          // per-request input error, not a change in the world worth
          // re-asking about, and routing it here would let any token holder
          // drive this handler (and the notification it sends) with junk.
          .error((err) => {
            caught.push(err);
            return { reasked: true };
          })
          .from(direct())
          .defer({ schema: Approval })
          .tap((ex) => {
            ran.push(ex.deferral.result);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
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
    expect(caught).toHaveLength(0);

    // Still resumable: the answerer corrects the payload and the
    // continuation runs exactly as it would have the first time.
    const acknowledgment = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string } };
    expect(acknowledgment.status).toBe("resumed");
    expect(acknowledgment.outcome.status).toBe("completed");
    expect(ran).toHaveLength(1);
    expect(caught).toHaveLength(0);
  });

  /**
   * @case A resume arriving after the deferral's ttl elapsed
   * @preconditions .defer({ ttl: "1ms" }); the answer is presented after the deadline
   * @expectedResult RC5047 in the ingress route, route:exchange:expired on the registry, and the deferred route's .error() handler sees it so it can re-ask
   */
  test("an expired deferral refuses the answer with RC5047", async () => {
    const caught: unknown[] = [];
    const expired: unknown[] = [];
    t = await testContext()
      .with(deferring())
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
          .defer({ schema: Approval, ttl: "1ms" })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
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
   * @preconditions A token this deployment never minted, and a well-formed token naming no stored deferral
   * @expectedResult RC5041 for the forgery and RC5046 for the unknown id, both in the ingress route
   */
  test("a forged token is RC5041 and an unknown deferral is RC5046", async () => {
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
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

    const runtime = t.ctx.getStore(DEFERRAL_RUNTIME);
    const orphan = runtime!.signer.mint("no-such-deferral~0");
    await expect(
      t.client.sendDirect("answers", {
        token: orphan,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5046" });
  });

  /**
   * @case The route keeps serving other exchanges while one is parked
   * @preconditions One exchange parked at a defer inside a .choice() branch; a second exchange takes the fast path while it is parked
   * @expectedResult The second exchange completes normally and the parked one still resumes afterwards, proving nothing waits on the route
   */
  test("a parked exchange does not block the route", async () => {
    const completed: unknown[] = [];
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from<Payout>(direct())
          .choice(
            when<Payout>(
              (ex) => ex.body.amountCents >= 50_000,
              (b) => b
                .defer({ schema: Approval })
                .filter((ex) =>
                  ex.deferral.result.approved ? true : { reason: "rejected" },
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

    const parked = asDeferred(
      await t.client.sendDirect("payout", {
        amountCents: 90_000,
        payee: "big",
      }),
    );
    // The route is still live: this one never touches the defer branch.
    const fast = await t.client.sendDirect("payout", {
      amountCents: 100,
      payee: "small",
    });
    expect(isDeferred(fast)).toBe(false);
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
   * @case A rejected verdict is consumed inside the defer branch
   * @preconditions The branch ends in .filter() reading ex.deferral.result; the answer is a rejection
   * @expectedResult The exchange is dropped inside the branch and never reaches the main flow's steps
   */
  test("a rejected verdict drops the exchange inside the branch", async () => {
    const paid: unknown[] = [];
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from<Payout>(direct())
          .choice(
            when<Payout>(
              (ex) => ex.body.amountCents >= 50_000,
              (b) => b.defer({ schema: Approval }).filter((ex) =>
                ex.deferral.result.approved
                  ? true
                  : {
                      reason: `rejected by ${ex.deferral.resumedBy?.subject ?? "anonymous"}`,
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

    const parked = asDeferred(
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
   * @case The deferral token is readable before the defer step runs
   * @preconditions A .tap() ahead of the .defer() reads ex.deferral.token and ex.deferral.id
   * @expectedResult The values it read are the ones the eventual acknowledgment carries, so a notification sent before the park contains a working link
   */
  test("ex.deferral.token is mintable before the defer step", async () => {
    const notified: Array<{ id: string; token: string }> = [];
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .tap((ex) => {
            notified.push({
              id: ex.deferral.id,
              token: ex.deferral.token,
            });
          })
          .defer({ schema: Approval })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    await t.drain();

    expect(notified).toHaveLength(1);
    expect(notified[0]?.id).toBe(parked.deferralId);
    // Tokens are minted per call, so compare what they resolve to rather
    // than the strings: what matters is that the early one resumes.
    const acknowledgment = await t.client.sendDirect("answers", {
      token: notified[0]!.token,
      result: { approved: true },
    });
    expect(acknowledgment).toMatchObject({ status: "resumed" });
  });

  /**
   * @case The answering principal is recorded on the deferral
   * @preconditions The resume ingress authenticates its caller before .resume()
   * @expectedResult ex.deferral.resumedBy carries that subject on the continuation, so the receipt reads "this principal authorized this operation" rather than "someone answered"
   */
  test("resumedBy is recorded from the ingress route's principal", async () => {
    const receipts: Array<{
      subject: string | undefined;
      at: Date | undefined;
    }> = [];
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .tap((ex) => {
            receipts.push({
              subject: ex.deferral.resumedBy?.subject,
              at: ex.deferral.resumedAt,
            });
          })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .authenticate(() => ({
            scheme: "test",
            subject: "approver@acme.test",
            issuer: "https://idp.test",
          }))
          .resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    });
    await t.drain();

    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.subject).toBe("approver@acme.test");
    expect(receipts[0]?.at).toBeInstanceOf(Date);
  });

  /**
   * @case A principal that came back from the store is not a verified one
   * @preconditions The parked exchange carried an authenticated principal; the continuation runs authorize()
   * @expectedResult RC5043: the restored shape has no live credential behind it, so the continuation must re-verify rather than trust what was read off disk (#355)
   */
  test("a resumed exchange's principal is refused by authorize", async () => {
    const reached: unknown[] = [];
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .authenticate(() => ({
            scheme: "test",
            subject: "requester@acme.test",
            roles: ["payer"],
          }))
          .defer({ schema: Approval })
          .validate(authorize({ roles: ["payer"] }))
          .tap((ex) => {
            reached.push(ex.body);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    const acknowledgment = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { outcome: { status: string; error?: { rc?: string } } };

    expect(acknowledgment.outcome.status).toBe("failed");
    expect(acknowledgment.outcome.error?.rc).toBe("RC5043");
    expect(reached).toHaveLength(0);
  });

  /**
   * @case A revived exchange keeps the identity it parked with
   * @preconditions An exchange parks, then resumes; ids are captured on both sides of the park
   * @expectedResult Execution two runs under the SAME routecraft.id and correlation id as execution one, because a resume is a continuation rather than a route ingress (#573 mints a fresh id at every ingress); deferral ids are derived from the exchange id, and the deferred / resumed / expired events key off it
   */
  test("a resumed exchange retains its exchange id and correlation id", async () => {
    const seen: Array<{ phase: string; id: string; correlationId: unknown }> =
      [];
    // `.process()`, not `.tap()`: a tap runs against a snapshot with a fresh
    // `routecraft.id` by design, so it cannot answer a question about the
    // identity of the exchange itself.
    const capture =
      (phase: string) =>
      (ex: Exchange<unknown>): Exchange<unknown> => {
        seen.push({
          phase,
          id: ex.id,
          correlationId: ex.headers["routecraft.correlation_id"],
        });
        return ex;
      };

    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .process(capture("before"))
          .defer({ schema: Approval })
          .process(capture("after"))
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    });
    await t.drain();

    expect(seen.map((entry) => entry.phase)).toEqual(["before", "after"]);
    expect(seen[1]?.id).toBe(seen[0]!.id);
    expect(seen[1]?.correlationId).toBe(seen[0]!.correlationId);
    // And the deferral the token named is derived from that same id, which
    // is what keeps the :deferred and :resumed events on one exchange.
    expect(parked.deferralId.startsWith(seen[0]!.id)).toBe(true);
  });

  /**
   * @case A continuation that reaches a second .defer() is not a completion
   * @preconditions A two-stage approval: the continuation of the first park contains another .defer()
   * @expectedResult The first deferral's terminal outcome is "deferred" with no body, so the receipt does not claim the work finished and the first approver's response does not carry the second approver's resume token
   */
  test("a chained deferral records a deferred outcome, not a completion", async () => {
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .defer({ schema: Approval })
          .transform(() => ({ paid: true }))
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    const first = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as {
      status: string;
      outcome: { status: string; body?: unknown };
    };

    expect(first.status).toBe("resumed");
    expect(first.outcome.status).toBe("deferred");
    // No body: it would be the SECOND acknowledgment, token included.
    expect(first.outcome.body).toBeUndefined();

    const duplicate = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string; body?: unknown } };
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.outcome.status).toBe("deferred");
    expect(duplicate.outcome.body).toBeUndefined();
  });

  /**
   * @case A changed continuation is reported to the deferred route once, not once per replay
   * @preconditions A parked exchange whose route changed under it; the same token is presented twice
   * @expectedResult Both attempts fail in the ingress, but the deferred route's .error() handler runs exactly once: a replayed token cannot drive its re-ask notifications
   */
  test("a changed continuation re-asks exactly once across replays", async () => {
    const store = new MemoryDeferralStore();
    const shared: CraftConfig = {
      deferral: { store, secret: SECRET },
    };

    const parkContext = await testContext()
      .with(shared)
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .transform((body) => ({ paid: (body as Payout).amountCents }))
          .to(noop()),
      ])
      .build();
    await parkContext.startAndWaitReady();
    const parked = asDeferred(
      await parkContext.client.sendDirect("payout", {
        amountCents: 25_000,
        payee: "acme",
      }),
    );
    await parkContext.stop();

    const caught: unknown[] = [];
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
          .defer({ schema: Approval })
          .transform((body) => ({ paid: (body as Payout).amountCents * 2 }))
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const answer = () =>
      t!.client.sendDirect("answers", {
        token: parked.token,
        result: { approved: true },
      });

    await expect(answer()).rejects.toMatchObject({ rc: "RC5048" });
    // The replay still fails, and still fails in the ingress route.
    await expect(answer()).rejects.toMatchObject({ rc: "RC5050" });
    expect(caught).toHaveLength(1);
  });

  /**
   * @case The route lost its .defer() entirely, rather than changing its tail
   * @preconditions The exchange parks; the redeployed route has no .defer() at the stored position; the token is then replayed
   * @expectedResult The stored denial reason names the cause it was actually refused for, so the RC5050 a replay reads back does not report a changed continuation for a route that no longer defers at all
   */
  test("a removed defer site records its own denial reason", async () => {
    const store = new MemoryDeferralStore();
    const shared: CraftConfig = {
      deferral: { store, secret: SECRET },
    };

    const parkContext = await testContext()
      .with(shared)
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await parkContext.startAndWaitReady();
    const parked = asDeferred(
      await parkContext.client.sendDirect("payout", {
        amountCents: 25_000,
        payee: "acme",
      }),
    );
    await parkContext.stop();

    t = await testContext()
      .with(shared)
      .routes([
        // The approval step is gone: this route no longer defers at all.
        craft().id("payout").from(direct()).to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const answer = () =>
      t!.client.sendDirect("answers", {
        token: parked.token,
        result: { approved: true },
      });

    await expect(answer()).rejects.toMatchObject({ rc: "RC5048" });
    await expect(answer()).rejects.toMatchObject({
      rc: "RC5050",
      message: expect.stringContaining("defer site removed"),
    });
  });

  /**
   * @case A continuation refusal that loses its compare-and-swap to a concurrent sweep
   * @preconditions The route changed under a parked exchange, and the record reaches a terminal state between the read and the denial
   * @expectedResult The losing request reports the winner's terminal state (RC5047) rather than its own RC5048, matching the expiry and duplicate paths: whoever won the transition says what happened
   */
  test("a denial that loses the race reports the winner's outcome", async () => {
    /** A store whose denial claim always arrives second, as a sweep would make it. */
    class SweptStore extends MemoryDeferralStore {
      override async claimExpiry(id: string, at: Date) {
        const sweep = await super.claimExpiry(id, at);
        if (sweep.won) await super.markExpired(id);
        return super.claimExpiry(id, at);
      }
    }

    const store = new SweptStore();
    const shared: CraftConfig = {
      deferral: { store, secret: SECRET },
    };

    const parkContext = await testContext()
      .with(shared)
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .transform((body) => ({ paid: (body as Payout).amountCents }))
          .to(noop()),
      ])
      .build();
    await parkContext.startAndWaitReady();
    const parked = asDeferred(
      await parkContext.client.sendDirect("payout", {
        amountCents: 25_000,
        payee: "acme",
      }),
    );
    await parkContext.stop();

    const caught: unknown[] = [];
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
          .defer({ schema: Approval })
          .transform((body) => ({ paid: (body as Payout).amountCents * 2 }))
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
    ).rejects.toMatchObject({ rc: "RC5047" });
    // The sweep owned the notification, so this request must not send a
    // second one for the same deferral.
    expect(caught).toHaveLength(0);
  });

  /**
   * @case A resume-only ingress in a context with no deferral runtime
   * @preconditions A route ending in .resume() and no `deferral` config; no route defers
   * @expectedResult The context refuses to start with RC5052, rather than becoming live and rejecting every answer at request time
   */
  test("starting a resume-only route without a deferral runtime is RC5052", async () => {
    const unconfigured = await testContext()
      .routes([craft().id("answers").from(direct()).resume().to(noop())])
      .build();

    await expect(unconfigured.ctx.start()).rejects.toMatchObject({
      rc: "RC5052",
    });
  });

  /**
   * @case Deferral lifecycle events land on the fixed event registry
   * @preconditions A park and a resume observed through ctx.on()
   * @expectedResult route:exchange:deferred carries the deferral id and position and replaces :completed for execution one; route:exchange:resumed precedes execution two's :started / :completed
   */
  test("deferred and resumed events fire on the fixed registry", async () => {
    const seen: string[] = [];
    const details: Record<string, unknown[]> = {
      deferred: [],
      resumed: [],
    };
    const record = (name: string) =>
      ((payload: { details: unknown }) => {
        seen.push(name);
        details[name]?.push(payload.details);
      }) as never;

    t = await testContext()
      .with(deferring())
      .on("route:exchange:deferred" as EventName, record("deferred"))
      .on("route:exchange:resumed" as EventName, record("resumed"))
      .on("route:exchange:completed" as EventName, record("completed"))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    expect(seen.filter((name) => name === "deferred")).toHaveLength(1);
    expect(details["deferred"]?.[0]).toMatchObject({
      routeId: "payout",
      deferralId: parked.deferralId,
      position: 0,
    });

    await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    });
    expect(details["resumed"]?.[0]).toMatchObject({
      routeId: "payout",
      deferralId: parked.deferralId,
    });
    expect(seen.indexOf("resumed")).toBeLessThan(seen.lastIndexOf("completed"));
  });

  /**
   * @case An exchange holding a value that cannot be persisted
   * @preconditions A step puts a function on the body before the defer
   * @expectedResult The defer fails with RC5042 at park time (not at resume), naming the offending path, and the exchange never reaches the store
   */
  test("defer refuses an exchange that cannot be persisted", async () => {
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .transform(() => ({ callback: () => "nope" }))
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    ).rejects.toMatchObject({ rc: "RC5042" });
  });

  /**
   * @case A route that can defer runs in a context with no deferral config
   * @preconditions No `deferral` block on the context
   * @expectedResult context.start() refuses with RC5052 rather than parking into a store nobody chose
   */
  test("starting a deferrable route without a deferral runtime is RC5052", async () => {
    // Deliberately not assigned to `t`: the context never starts, so there
    // is nothing to tear down, and `TestContext.stop()` re-throws a failed
    // start.
    const unconfigured = await testContext()
      .routes([
        craft()
          .id("payout")
          .from(simple({ amountCents: 1 }))
          .defer({ schema: Approval })
          .to(log()),
      ])
      .build();

    await expect(unconfigured.ctx.start()).rejects.toMatchObject({
      rc: "RC5052",
    });
  });

  /**
   * @case .defer() inside an unbalanced .split()
   * @preconditions A route that splits an array and defers per child
   * @expectedResult craft().build() refuses with RC5051 rather than parking children nothing can aggregate
   */
  test("defer inside .split() is refused at build time", () => {
    expect(() =>
      craft()
        .id("bulk")
        .from(direct())
        .split()
        .defer({ schema: Approval })
        .to(noop())
        .build(),
    ).toThrow(expect.objectContaining({ rc: "RC5051" }) as unknown as Error);
  });

  /**
   * @case .defer() inside a .multicast() path
   * @preconditions A route that fans out and defers inside one path
   * @expectedResult craft().build() refuses with RC5051: a path exchange is an isolated side flow with nowhere to rejoin
   */
  test("defer inside a .multicast() path is refused at build time", () => {
    expect(() =>
      craft()
        .id("fanout")
        .from(direct())
        .multicast((b) => b.defer({ schema: Approval }).to(noop()))
        .to(noop())
        .build(),
    ).toThrow(expect.objectContaining({ rc: "RC5051" }) as unknown as Error);
  });

  /**
   * @case Route-scope .cache() on a route that can defer
   * @preconditions .cache() staged before .from(), and a .defer() in the pipeline
   * @expectedResult craft().build() refuses with RC5003: the cache filters wrap the user pipeline, which a park exits and a resume re-enters partway down, so the cache would silently never run
   */
  test("route-scope .cache() with a reachable defer is refused at build time", () => {
    expect(() =>
      craft()
        .id("payout")
        .cache()
        .from(direct())
        .defer({ schema: Approval })
        .to(noop())
        .build(),
    ).toThrow(expect.objectContaining({ rc: "RC5003" }) as unknown as Error);
  });

  /**
   * @case The deferred route's error-channel re-entry is a complete run
   * @preconditions An expired deferral whose route has a route-scope .error() that recovers
   * @expectedResult The re-ask emits one exchange:started and one terminal event for that exchange, so the lifecycle guarantee holds for the re-entry as well
   */
  test("the error-channel re-entry emits a balanced lifecycle pair", async () => {
    const lifecycle: Array<{ event: string; routeId: string }> = [];
    const record = (event: string) =>
      ((payload: { details: { routeId: string } }) => {
        lifecycle.push({ event, routeId: payload.details.routeId });
      }) as never;

    t = await testContext()
      .with(deferring())
      .on("route:exchange:started" as EventName, record("started"))
      .on("route:exchange:completed" as EventName, record("completed"))
      .on("route:exchange:failed" as EventName, record("failed"))
      .on("route:exchange:deferred" as EventName, record("deferred"))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .defer({ schema: Approval, ttl: "1ms" })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(
      t.client.sendDirect("answers", {
        token: parked.token,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5047" });

    // Execution one: started then deferred. The re-ask: started then
    // completed, because the route-scope handler recovered. The ingress
    // route has its own pair and is filtered out by routeId.
    expect(
      lifecycle
        .filter((entry) => entry.routeId === "payout")
        .map((entry) => entry.event),
    ).toEqual(["started", "deferred", "started", "completed"]);
  });

  /**
   * @case A step-scope wrapper around .defer()
   * @preconditions .retry() staged immediately before a .defer()
   * @expectedResult The wrapper refuses at construction (RC5003): parking is not a failure to re-attempt, and a wrapped park has no coherent recovery
   */
  test("a step-scope wrapper cannot wrap .defer()", () => {
    expect(() =>
      craft()
        .id("payout")
        .from(direct())
        .retry()
        .defer({ schema: Approval })
        .to(noop()),
    ).toThrow(expect.objectContaining({ rc: "RC5003" }) as unknown as Error);
  });

  /**
   * @case The expect schema types ex.deferral.result downstream of the defer
   * @preconditions A chain whose defer declares a zod object schema
   * @expectedResult The narrowed field is readable without a cast, and stays unknown before any defer (compile-time assertion; the runtime body is incidental)
   */
  test("expect threads its type into ex.deferral.result", async () => {
    const seen: string[] = [];
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("typed")
          .from(direct())
          .tap((ex: Exchange<unknown>) => {
            const before: unknown = ex.deferral.result;
            seen.push(typeof before);
          })
          .defer({ schema: Approval })
          .tap((ex) => {
            // No cast: `approved` is boolean because `expect` said so.
            const approved: boolean = ex.deferral.result.approved;
            seen.push(String(approved));
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
      await t.client.sendDirect("typed", { amountCents: 1, payee: "acme" }),
    );
    await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    });
    await t.drain();

    expect(seen).toEqual(["undefined", "true"]);
  });

  /**
   * @case An answer that arrives in time but validates past the deadline
   * @preconditions .defer({ ttl: "200ms" }) with an expect schema whose async validate sleeps well past it; the answer is presented before the deadline
   * @expectedResult RC5047 in the ingress route, a failed terminal carrying RC5047, and one re-ask. The deadline is re-checked AFTER winning markResumed because validation is user code that can await; without the re-check a slow validation would run the continuation past the window its route declared closed
   */
  test("a slow validation cannot carry an answer past the deadline", async () => {
    const caught: unknown[] = [];
    const continued: unknown[] = [];
    const SlowApproval = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value: unknown) => {
          // Comfortably past the 200ms ttl; the ttl itself is generous so a
          // slow CI cannot let the answer ARRIVE after the deadline, which
          // would exercise the entry check instead of the post-CAS one.
          await new Promise((resolve) => setTimeout(resolve, 450));
          return { value };
        },
      },
    };

    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            caught.push(err);
            return { reasked: true };
          })
          .from(direct())
          .defer({ schema: SlowApproval as never, ttl: "200ms" })
          .tap((ex) => {
            continued.push(ex.body);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );

    // Presented immediately, so the entry deadline check passes; the
    // validation sleep is what carries the clock past the deadline.
    await expect(
      t.client.sendDirect("answers", {
        token: parked.token,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5047" });

    expect(continued).toHaveLength(0);
    expect(caught).toHaveLength(1);
    const runtime = t.ctx.getStore(DEFERRAL_RUNTIME);
    const record = await runtime?.store.get(parked.deferralId);
    expect(record?.status).toBe("resumed");
    expect(record?.terminal?.status).toBe("failed");
    expect(record?.terminal?.error?.rc).toBe("RC5047");
  });

  /**
   * @case The terminal cache write fails after a continuation succeeded
   * @preconditions A store whose recordTerminal throws once execution two completes
   * @expectedResult The answerer still receives the completed acknowledgment. The work is done and destinations fired, so a transient store error at that moment must not report the work as failed; the only cost is that a duplicate resume is told the outcome is unrecorded
   */
  test("a failed terminal cache write does not fail a completed resume", async () => {
    const backing = new MemoryDeferralStore();
    const store = storeWith(backing, {
      recordTerminal: async (id, terminal) => {
        if (terminal.status === "completed") {
          throw new Error("the database went away");
        }
        return backing.recordTerminal(id, terminal);
      },
    });

    t = await testContext()
      .with({ deferral: { store } } as CraftConfig)
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .transform((body) => ({ paid: (body as Payout).amountCents }))
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asDeferred(
      await t.client.sendDirect("payout", {
        amountCents: 25_000,
        payee: "acme",
      }),
    );

    const acknowledgment = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string } };

    expect(acknowledgment.status).toBe("resumed");
    expect(acknowledgment.outcome.status).toBe("completed");
    expect((await backing.get(parked.deferralId))?.terminal).toBeUndefined();
  });
});

describe("the deferral sequence guard", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A missing sequence header is the counter at zero
   * @preconditions Headers without the framework-owned sequence entry
   * @expectedResult readSequence returns 0 and the derived id carries ~0,
   *   because every exchange that has never parked legitimately carries no
   *   counter
   */
  test("a missing header reads as zero", async () => {
    const { readSequence, deferralIdOf } =
      await import("../src/deferral/exchange-state.ts");
    expect(readSequence({})).toBe(0);
    expect(deferralIdOf({}, "ex-1")).toBe("ex-1~0");
  });

  /**
   * @case A tampered sequence header refuses instead of resetting
   * @preconditions Header values a counter cannot use: a string, a negative,
   *   a float, and a non-safe integer
   * @expectedResult RC5057 naming the header as malformed for each, never a
   *   silent reset to 0: a reset re-derives an id an earlier park already
   *   used, and resume tokens sign the id
   */
  test("a malformed header refuses with RC5057", async () => {
    const { readSequence } = await import("../src/deferral/exchange-state.ts");
    const key = "routecraft.deferral.sequence";
    for (const bad of ["3", -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      try {
        readSequence({ [key]: bad as never });
        throw new Error(`accepted ${String(bad)}`);
      } catch (error) {
        expect(error).toMatchObject({ rc: "RC5057" });
        expect(String((error as Error).message)).toContain("malformed");
      }
    }
  });

  /**
   * @case Exhaustion is refused distinguishably, and the bound is coherent
   * @preconditions The bound value, and the last acceptable value below it
   * @expectedResult The bound refuses with an exhaustion message (not
   *   "malformed"); its predecessor is accepted, and the successor a park
   *   would write for it is exactly the bound, so the failure surfaces on
   *   the next read instead of resetting
   */
  test("the exhaustion bound refuses distinguishably from tampering", async () => {
    const { readSequence } = await import("../src/deferral/exchange-state.ts");
    const key = "routecraft.deferral.sequence";
    const bound = Number.MAX_SAFE_INTEGER - 1;
    try {
      readSequence({ [key]: bound });
      throw new Error("accepted the bound");
    } catch (error) {
      expect(error).toMatchObject({ rc: "RC5057" });
      expect(String((error as Error).message)).toContain("exhausted");
    }
    expect(readSequence({ [key]: bound - 1 })).toBe(bound - 1);
  });

  /**
   * @case A route that mangles the framework header cannot park
   * @preconditions A step overwrites the sequence header with a string
   *   before .defer()
   * @expectedResult The park fails with RC5057 as an ordinary step failure
   *   (the exchange was never parked and no record exists), instead of
   *   deriving a reused id from a reset counter
   */
  test("a park after header tampering fails with RC5057 and writes nothing", async () => {
    t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .header("routecraft.deferral.sequence", "oops")
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("payout", { amountCents: 1_000, payee: "acme" }),
    ).rejects.toMatchObject({ rc: "RC5057" });

    const runtime = t.ctx.getStore(DEFERRAL_RUNTIME)!;
    expect((await runtime.store.pending()).count).toBe(0);
  });
});
