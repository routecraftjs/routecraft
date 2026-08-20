import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  MemorySuspensionStore,
  type CraftContext,
  SUSPENSION_RUNTIME,
  craft,
  direct,
  noop,
  type CraftConfig,
  type Exchange,
  type ResumeAuthorizerInput,
  type Suspension,
} from "../src/index.ts";
import { describeSchema } from "../src/suspension/hash.ts";
import {
  SUSPENDED_JSON_SCHEMA,
  suspendedSchema,
} from "../src/suspension/suspended.ts";
import { asSuspended, storeWith, suspending } from "./helpers/suspension.ts";

const SECRET = "suspend-authorization-test-secret-0123456789";

const Approval = z.object({ approved: z.boolean() });

/** Config sharing one store across two contexts, for the redeploy cases. */
function shared(store: MemorySuspensionStore): CraftConfig {
  return { suspension: { store, secret: SECRET } };
}

/** A route that mints a principal from the ingress body's `who` field. */
function asWho(ex: Exchange) {
  const body = ex.body as { who?: string; scopes?: string[] } | null;
  return body?.who
    ? {
        subject: body.who,
        ...(body.scopes ? { scopes: body.scopes } : {}),
      }
    : undefined;
}

describe("who may answer a suspension", () => {
  let t: TestContext | undefined;
  let other: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    if (other) await other.stop();
    t = undefined;
    other = undefined;
  });

  /**
   * @case The declarative floor is enforced from the record, not from the live site
   * @preconditions A record parked under answer: { sub: "different" }; the site is then edited to sub: "any" in a second context sharing the store
   * @expectedResult The parked record still refuses the parking principal with RC5056, because policy travels with the question rather than with the site
   */
  test("policy travels with the question, not with the site", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .authenticate(asWho)
          .suspend({ schema: Approval, answer: { sub: "different" } })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { who: "alice" }),
    );
    await t.stop();
    t = undefined;

    // The redeploy weakens the site to bearer. The record must not follow.
    other = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .authenticate(asWho)
          .suspend({ schema: Approval, answer: { sub: "any" } })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .authenticate(asWho)
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: { approved: true },
          })),
      ])
      .build();
    await other.startAndWaitReady();

    await expect(
      other.client.sendDirect("answers", { who: "alice", token: parked.token }),
    ).rejects.toThrow(/RC5056|may not answer/);

    // Still resumable by someone who does qualify: the refusal changed nothing.
    const record = await store.get(parked.suspensionId);
    expect(record?.status).toBe("suspended");
    await other.client.sendDirect("answers", {
      who: "bob",
      token: parked.token,
    });
    expect((await store.get(parked.suspensionId))?.status).toBe("resumed");
  });

  /**
   * @case A wrongly-bound credential is refused before the destructive hash arm can run
   * @preconditions A record parked with a per-call binding whose route is then edited, so the stored continuation hash no longer matches
   * @expectedResult The wrong credential takes RC5055 and the record is left neither denied nor claimed, so the rightful credential still gets its RC5048 re-ask rather than finding a dead link
   */
  test("band 1 refuses before a hash mismatch can burn the record", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: { approved: true },
          })),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    // Bind the record to a call, as a batching agent park would, and break
    // the continuation, as a redeploy would. Both halves are needed: the
    // point is that the credential check runs first.
    const record = (await store.get(parked.suspensionId)) as Suspension;
    await store.create({
      ...record,
      id: `${record.id}-bound`,
      callBinding: "call-winner",
      continuationHash: "0".repeat(64),
      status: undefined,
      terminal: undefined,
      resumedAt: undefined,
      resumedBy: undefined,
      claimedAt: undefined,
      deniedReason: undefined,
    } as never);

    const runtime = t.ctx.getStore(SUSPENSION_RUNTIME)!;
    const wrong = runtime.signer.mint(
      `${record.id}-bound`,
      new Date(),
      "call-loser",
    );
    const rightful = runtime.signer.mint(
      `${record.id}-bound`,
      new Date(),
      "call-winner",
    );

    await expect(
      t.client.sendDirect("answers", { token: wrong }),
    ).rejects.toThrow(/RC5055|not minted for/);

    const untouched = await store.get(`${record.id}-bound`);
    expect(untouched?.status).toBe("suspended");
    expect(untouched?.deniedReason).toBeUndefined();
    expect(untouched?.claimedAt).toBeUndefined();

    // Only now, on a credential that belongs here, does the mismatch settle.
    await expect(
      t.client.sendDirect("answers", { token: rightful }),
    ).rejects.toThrow(/RC5048|changed after position/);
    expect((await store.get(`${record.id}-bound`))?.status).toBe("denied");
  });

  /**
   * @case A resume door that resolves no principal cannot satisfy a declared policy
   * @preconditions A record parked under answer: { scopes: [...] } and a .resume() route with no .authenticate()
   * @expectedResult RC5056 naming the ingress misconfiguration rather than the answerer, and the record stays resumable
   */
  test("an unauthenticated ingress fails closed on a declared policy", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({
            schema: Approval,
            answer: { scopes: ["payouts:approve"] },
          })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: { approved: true },
          })),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await expect(
      t.client.sendDirect("answers", { token: parked.token }),
    ).rejects.toThrow(/resolves no principal/);
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");
  });

  /**
   * @case sub: "same" refuses when either side carries no subject claim
   * @preconditions A record parked with no principal at all, under answer: { sub: "same" }
   * @expectedResult RC5056 rather than an accidental match of two absent subjects
   */
  test('sub: "same" refuses an absent subject on either side', async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval, answer: { sub: "same" } })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .authenticate(asWho)
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: { approved: true },
          })),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await expect(
      t.client.sendDirect("answers", { who: "alice", token: parked.token }),
    ).rejects.toThrow(/carries no subject claim/);
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");
  });

  /**
   * @case A door only answers the channels it declares
   * @preconditions One record parked on key "finance" and two doors, one serving "ops" and one serving "finance"
   * @expectedResult The wrong door takes RC5057 without touching the record, and the right door resumes it
   */
  test("a keyed record is answerable only through a door that serves it", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval, key: "finance" })
          .to(noop()),
        craft()
          .id("ops-door")
          .from(direct())
          .resume(
            (ex) => ({
              token: (ex.body as { token: string }).token,
              result: { approved: true },
            }),
            { keys: ["ops"] },
          ),
        craft()
          .id("finance-door")
          .from(direct())
          .resume(
            (ex) => ({
              token: (ex.body as { token: string }).token,
              result: { approved: true },
            }),
            { keys: ["finance"] },
          ),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await expect(
      t.client.sendDirect("ops-door", { token: parked.token }),
    ).rejects.toThrow(/RC5057|does not serve/);
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");

    await t.client.sendDirect("finance-door", { token: parked.token });
    expect((await store.get(parked.suspensionId))?.status).toBe("resumed");
  });

  /**
   * @case Editing an authorize() predicate invalidates records parked under the previous one
   * @preconditions A record parked under one predicate, then a redeploy whose site declares a differently-sourced predicate
   * @expectedResult RC5048, the same re-ask a changed continuation gets, rather than the new predicate silently governing an old question
   */
  test("an edited predicate takes the RC5048 re-ask", async () => {
    const store = new MemorySuspensionStore();
    const before = craft()
      .id("payout")
      .from(direct())
      .authenticate(asWho)
      .suspend({
        schema: Approval,
        answer: { sub: "any" },
        authorize: ({ answerer }: ResumeAuthorizerInput) =>
          answerer.subject === "alice",
      })
      .to(noop());
    const after = craft()
      .id("payout")
      .from(direct())
      .authenticate(asWho)
      .suspend({
        schema: Approval,
        answer: { sub: "any" },
        authorize: ({ answerer }: ResumeAuthorizerInput) =>
          answerer.subject === "bob",
      })
      .to(noop());

    t = await testContext().with(shared(store)).routes([before]).build();
    await t.startAndWaitReady();
    const parked = asSuspended(
      await t.client.sendDirect("payout", { who: "carol" }),
    );
    await t.stop();
    t = undefined;

    other = await testContext()
      .with(shared(store))
      .routes([
        after,
        craft()
          .id("answers")
          .from(direct())
          .authenticate(asWho)
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: { approved: true },
          })),
      ])
      .build();
    await other.startAndWaitReady();

    await expect(
      other.client.sendDirect("answers", { who: "bob", token: parked.token }),
    ).rejects.toThrow(/RC5048|changed after position/);
  });

  /**
   * @case A predicate refuses identically whether it returns false or throws
   * @preconditions Two sites, one whose predicate returns false and one whose predicate throws a cause carrying an internal detail
   * @expectedResult Both answer RC5056 with the same generic message, and neither leaks the thrown cause to the answerer
   */
  test("false and a throw are identical on the wire", async () => {
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("says-no")
          .from(direct())
          .authenticate(asWho)
          .suspend({ answer: { sub: "any" }, authorize: () => false })
          .to(noop()),
        craft()
          .id("blows-up")
          .from(direct())
          .authenticate(asWho)
          .suspend({
            answer: { sub: "any" },
            authorize: () => {
              throw new Error("https://idp.internal/introspect timed out");
            },
          })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .authenticate(asWho)
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: { approved: true },
          })),
      ])
      .build();
    await t.startAndWaitReady();

    const messages: string[] = [];
    for (const route of ["says-no", "blows-up"]) {
      const parked = asSuspended(
        await t.client.sendDirect(route, { who: "alice" }),
      );
      try {
        await t.client.sendDirect("answers", {
          who: "alice",
          token: parked.token,
        });
        throw new Error("expected a refusal");
      } catch (err) {
        messages.push((err as Error).message);
      }
    }
    expect(messages[0]).toContain("refused this answerer");
    expect(messages[1]).toContain("refused this answerer");
    expect(messages[1]).not.toContain("idp.internal");
  });

  /**
   * @case A predicate that never settles is refused rather than left to widen the pre-claim window
   * @preconditions suspension.authorizeTimeout set to 20ms and a predicate that never resolves
   * @expectedResult RC5056, and the record is left resumable
   */
  test("a predicate that overruns authorizeTimeout is refused", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with({
        suspension: { store, secret: SECRET, authorizeTimeout: "20ms" },
      })
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .authenticate(asWho)
          .suspend({
            answer: { sub: "any" },
            authorize: () => new Promise<boolean>(() => {}),
          })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .authenticate(asWho)
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: { approved: true },
          })),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { who: "alice" }),
    );
    await expect(
      t.client.sendDirect("answers", { who: "alice", token: parked.token }),
    ).rejects.toThrow(/refused this answerer/);
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");
  });

  /**
   * @case A deadline that elapses under a slow predicate reports the expiry, not an authorization failure
   * @preconditions A 1ms ttl and a predicate that resolves true after the deadline has passed
   * @expectedResult RC5047, so the answerer is told the window closed rather than that they were refused
   */
  test("an overrun deadline under a predicate reports RC5047", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with({ suspension: { store, secret: SECRET } })
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .authenticate(asWho)
          .suspend({
            ttl: "30ms",
            answer: { sub: "any" },
            authorize: async () => {
              await new Promise((resolve) => setTimeout(resolve, 60));
              return true;
            },
          })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .authenticate(asWho)
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: { approved: true },
          })),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { who: "alice" }),
    );
    await expect(
      t.client.sendDirect("answers", { who: "alice", token: parked.token }),
    ).rejects.toThrow(/RC5047|expired/);
  });

  /**
   * @case A site with no schema parks with no ingress contract at all
   * @preconditions .suspend() with no schema, resumed with a value no approval schema would accept
   * @expectedResult The park succeeds without a schema rendering, the answer is delivered unvalidated, and the descriptor records the absence
   */
  test("a schema-less site accepts any answer and records the absence", async () => {
    const store = new MemorySuspensionStore();
    const seen: unknown[] = [];
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("consent")
          .from(direct())
          .suspend({})
          .tap((ex) => {
            seen.push(ex.suspension.result);
          })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: (ex.body as { result: unknown }).result,
          })),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("consent", {}));
    expect(parked.schema).toBeUndefined();
    expect((await store.get(parked.suspensionId))?.schema.absent).toBe(true);

    await t.client.sendDirect("answers", {
      token: parked.token,
      result: "yes",
    });
    expect(seen).toEqual(["yes"]);
  });

  /**
   * @case The absent-schema descriptor is distinct from the degraded fallback
   * @preconditions A site with no schema, and a schema that advertises a JSON Schema extension producing nothing
   * @expectedResult Two different hashes, so editing a site between the two states moves the continuation digest and takes the re-ask
   */
  test("absent and degraded schema descriptors differ", () => {
    const degraded = {
      "~standard": {
        version: 1,
        vendor: "hostile",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => undefined,
          output: () => undefined,
        },
      },
    } as never;

    const absent = describeSchema(undefined);
    const advertised = describeSchema(degraded);
    expect(absent.absent).toBe(true);
    expect(advertised.degraded).toBe(true);
    expect(absent.hash).not.toBe(advertised.hash);
  });

  /**
   * @case A resumed run that parks again inherits the channel it was answered on
   * @preconditions A two-stage route whose first suspend declares key "finance" and whose second declares none
   * @expectedResult The second record carries the same key, so the door that served the first stage serves the second
   */
  test("a re-park inherits the resumed record's channel", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval, key: "finance" })
          .suspend({ schema: Approval })
          .to(noop()),
        craft()
          .id("finance-door")
          .from(direct())
          .resume(
            (ex) => ({
              token: (ex.body as { token: string }).token,
              result: { approved: true },
            }),
            { keys: ["finance"] },
          ),
      ])
      .build();
    await t.startAndWaitReady();

    const first = asSuspended(await t.client.sendDirect("payout", {}));
    const acknowledgment = (await t.client.sendDirect("finance-door", {
      token: first.token,
    })) as { outcome: { status: string } };
    expect(acknowledgment.outcome.status).toBe("suspended");

    // The second park mints its id from the same exchange at the next
    // sequence number, so it is the only other suspended record here.
    // The second park mints its id from the same exchange at the next
    // sequence number, so it is the only record still pending.
    const second = await store.get(
      first.suspensionId.replace(/~(\d+)$/, (_, n) => `~${Number(n) + 1}`),
    );
    expect(second?.status).toBe("suspended");
    expect(second?.key).toBe("finance");
  });

  /**
   * @case A store failure inside band 1 cannot be reached at all
   * @preconditions A record whose channel this door does not serve, over a store whose claimExpiry would throw
   * @expectedResult The refusal lands without any transition being attempted, proving band 1 touches nothing
   */
  test("band 1 attempts no store transition", async () => {
    const backing = new MemorySuspensionStore();
    let transitions = 0;
    const store = storeWith(backing, {
      claimExpiry: async (...args) => {
        transitions += 1;
        return backing.claimExpiry(...args);
      },
      markResumed: async (...args) => {
        transitions += 1;
        return backing.markResumed(...args);
      },
    });
    t = await testContext()
      .with({ suspension: { store, secret: SECRET } })
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval, key: "finance" })
          .to(noop()),
        craft()
          .id("ops-door")
          .from(direct())
          .resume(
            (ex) => ({
              token: (ex.body as { token: string }).token,
              result: { approved: true },
            }),
            { keys: ["ops"] },
          ),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await expect(
      t.client.sendDirect("ops-door", { token: parked.token }),
    ).rejects.toThrow(/does not serve/);
    expect(transitions).toBe(0);
  });

  /**
   * @case .resume({ keys }) refuses a shape that cannot name a channel
   * @preconditions An empty keys array
   * @expectedResult RC5003 at build time, rather than a door that silently serves nothing
   */
  test("an empty keys array is refused at build time", () => {
    expect(() =>
      craft().id("door").from(direct()).resume({ keys: [] }).build(),
    ).toThrow(/non-empty array/);
  });
});

/**
 * Record the context logger's output. The startup audit and the predicate
 * refusal both report through `context.logger`, which the harness's
 * route-scoped spy logger does not see.
 */
function captureWarnings(context: CraftContext): string[] {
  const lines: string[] = [];
  context.logger.warn = ((_: unknown, message: string) => {
    lines.push(message);
  }) as unknown as CraftContext["logger"]["warn"];
  return lines;
}

describe("wiring a policy past the doors that must honour it", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A context that mixes keyed suspend sites with a keyless door warns at startup
   * @preconditions One .suspend({ key }) and one .resume() declaring no keys
   * @expectedResult A startup warning naming both sides, because the keyless door removes the bound the keys were declared for
   */
  test("keyed sites next to a keyless door warn at startup", async () => {
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval, key: "finance" })
          .to(noop()),
        craft().id("any-door").from(direct()).resume(),
      ])
      .build();
    const warnings = captureWarnings(t.ctx);
    await t.startAndWaitReady();

    expect(warnings.some((line) => line.includes("serves every channel"))).toBe(
      true,
    );
  });

  /**
   * @case A declared answerer policy next to an ingress that resolves nobody warns at startup
   * @preconditions A .suspend({ answer }) and a .resume() route with no .authenticate() and no route-entry .authorize()
   * @expectedResult A startup warning, rather than the mismatch surfacing days later as an RC5056 on a link the approver was already sent
   */
  test("a policy next to an anonymous door warns at startup", async () => {
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval, answer: { sub: "different" } })
          .to(noop()),
        craft().id("any-door").from(direct()).resume(),
      ])
      .build();
    const warnings = captureWarnings(t.ctx);
    await t.startAndWaitReady();

    expect(
      warnings.some((line) => line.includes("resolves no principal")),
    ).toBe(true);
  });

  /**
   * @case A record parked on a channel no door serves is flagged when it parks
   * @preconditions A .suspend({ key: "finance" }) and only an "ops" door
   * @expectedResult A park-time warning, because nothing else would ever name the cause: the token is structurally valid and the record simply sits until its ttl
   */
  test("parking on an unserved channel warns at the park", async () => {
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval, key: "finance" })
          .to(noop()),
        craft()
          .id("ops-door")
          .from(direct())
          .resume(undefined, { keys: ["ops"] }),
      ])
      .build();
    await t.startAndWaitReady();

    // The park reports through the parking exchange's own logger, which is
    // the harness spy, not the context logger the startup audit uses.
    await t.client.sendDirect("payout", {});
    const said = t.logger.warn.mock.calls.some(
      (call) =>
        typeof call[1] === "string" && call[1].includes("no registered"),
    );
    expect(said).toBe(true);
  });

  /**
   * @case A thrown predicate cause is logged at the refusal and never returned
   * @preconditions A predicate throwing an error carrying an internal endpoint
   * @expectedResult The boundary log records the outcome and the cause; the answerer's error carries neither
   */
  test("a predicate cause is logged at the boundary, not returned", async () => {
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .authenticate(asWho)
          .suspend({
            answer: { sub: "any" },
            authorize: () => {
              throw new Error("https://idp.internal/introspect refused");
            },
          })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .authenticate(asWho)
          .resume((ex) => ({
            token: (ex.body as { token: string }).token,
            result: { approved: true },
          })),
      ])
      .build();
    await t.startAndWaitReady();

    const logged: Array<{
      bindings: Record<string, unknown>;
      message: string;
    }> = [];
    t.ctx.logger.warn = ((
      bindings: Record<string, unknown>,
      message: string,
    ) => {
      logged.push({ bindings, message });
    }) as unknown as CraftContext["logger"]["warn"];

    const parked = asSuspended(
      await t.client.sendDirect("payout", { who: "alice" }),
    );
    await expect(
      t.client.sendDirect("answers", { who: "alice", token: parked.token }),
    ).rejects.toThrow(/refused this answerer/);

    const line = logged.find((entry) =>
      entry.message.includes("authorize() predicate refused"),
    );
    expect(line?.bindings["outcome"]).toBe("threw");
    expect(String((line?.bindings["err"] as Error)?.message)).toContain(
      "idp.internal",
    );
  });
});

describe("the Suspended acknowledgment on the wire", () => {
  /**
   * @case Both wire enforcement points accept the declared key and reject the old one
   * @preconditions A structurally valid acknowledgment carrying `schema`, and the same value carrying `expect`
   * @expectedResult The structural fallback accepts the first and refuses the second, matching the advertised JSON Schema, which is closed for additional properties
   */
  test("the structural fallback and the advertised schema agree", () => {
    const advertised = SUSPENDED_JSON_SCHEMA.properties as Record<
      string,
      unknown
    >;
    expect(Object.keys(advertised)).toContain("schema");
    expect(Object.keys(advertised)).not.toContain("expect");
    expect(SUSPENDED_JSON_SCHEMA.additionalProperties).toBe(false);

    const base = {
      status: "suspended",
      suspensionId: "s-1",
      token: "t-1",
    };
    const accepted = suspendedSchema["~standard"].validate({
      ...base,
      schema: { type: "object" },
    });
    expect("value" in accepted).toBe(true);

    const refused = suspendedSchema["~standard"].validate({
      ...base,
      expect: { type: "object" },
    });
    expect("issues" in refused).toBe(true);
  });
});
