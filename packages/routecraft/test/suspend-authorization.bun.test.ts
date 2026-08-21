import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  MemorySuspensionStore,
  SUSPENSION_RUNTIME,
  craft,
  direct,
  noop,
  type CraftConfig,
  type CraftContext,
  type Exchange,
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

/** Mints a principal from the ingress body, standing in for a real verifier. */
function asWho(ex: Exchange) {
  const body = ex.body as { who?: string; scopes?: string[] } | null;
  return body?.who
    ? {
        subject: body.who,
        ...(body.scopes ? { scopes: body.scopes } : {}),
      }
    : undefined;
}

/** The mapper every door in these tests uses. */
function payloadFrom(ex: Exchange) {
  const body = ex.body as { token: string; result?: unknown };
  return {
    token: body.token,
    result: "result" in body ? body.result : { approved: true },
  };
}

describe("the resume authorize hook", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A door with no hook keeps the historical bearer behaviour exactly
   * @preconditions A parked record and a .resume() declaring no authorize
   * @expectedResult Any holder of a valid token resumes it, unchanged from before the hook existed
   */
  test("no hook is bearer, exactly as before", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
        craft().id("answers").from(direct()).resume(payloadFrom),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    const ack = (await t.client.sendDirect("answers", {
      token: parked.token,
    })) as { status: string };
    expect(ack.status).toBe("resumed");
    expect((await store.get(parked.suspensionId))?.status).toBe("resumed");
  });

  /**
   * @case A refused principal costs the rightful principal nothing and learns nothing
   * @preconditions A hook admitting only "alice", presented first by "bob"
   * @expectedResult Bob takes RC5056 against an untouched record, and alice then resumes it
   */
  test("refuse then rightful resume, with no claim burn", async () => {
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
          .authenticate(asWho)
          .resume(payloadFrom, {
            authorize: ({ principal }) => principal?.subject === "alice",
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await expect(
      t.client.sendDirect("answers", { who: "bob", token: parked.token }),
    ).rejects.toThrow(/refused this principal/);

    const untouched = await store.get(parked.suspensionId);
    expect(untouched?.status).toBe("suspended");
    expect(untouched?.claimedAt).toBeUndefined();
    expect(untouched?.deniedReason).toBeUndefined();

    const ack = (await t.client.sendDirect("answers", {
      who: "alice",
      token: parked.token,
    })) as { status: string };
    expect(ack.status).toBe("resumed");
  });

  /**
   * @case A refused principal cannot learn the record's lifecycle state
   * @preconditions A record already resumed, presented again by a principal the hook refuses
   * @expectedResult The hook's refusal, not the "duplicate" acknowledgment a bearer holder would receive
   */
  test("the hook runs before the settled-state disclosure", async () => {
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
          .authenticate(asWho)
          .resume(payloadFrom, {
            authorize: ({ principal }) => principal?.subject === "alice",
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await t.client.sendDirect("answers", {
      who: "alice",
      token: parked.token,
    });
    expect((await store.get(parked.suspensionId))?.status).toBe("resumed");

    // Alice would now read `duplicate`. Bob must not learn even that much.
    await expect(
      t.client.sendDirect("answers", { who: "bob", token: parked.token }),
    ).rejects.toThrow(/refused this principal/);
  });

  /**
   * @case A refused credential cannot settle a record whose route was edited
   * @preconditions A record whose stored continuation hash no longer matches, presented by a principal the hook refuses
   * @expectedResult The refusal wins first, leaving the record unclaimed and undenied; only the accepted principal reaches the RC5048 re-ask
   */
  test("a refused principal cannot burn a record on the hash arm", async () => {
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
          .authenticate(asWho)
          .resume(payloadFrom, {
            authorize: ({ principal }) => principal?.subject === "alice",
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    // Break the continuation the way a redeploy would.
    const record = (await store.get(parked.suspensionId)) as Suspension;
    await store.create({
      ...record,
      id: `${record.id}-edited`,
      continuationHash: "0".repeat(64),
      status: undefined,
      terminal: undefined,
      resumedAt: undefined,
      resumedBy: undefined,
      claimedAt: undefined,
      deniedReason: undefined,
    } as never);
    const runtime = t.ctx.getStore(SUSPENSION_RUNTIME)!;
    const token = runtime.signer.mint(`${record.id}-edited`);

    await expect(
      t.client.sendDirect("answers", { who: "bob", token }),
    ).rejects.toThrow(/refused this principal/);
    const untouched = await store.get(`${record.id}-edited`);
    expect(untouched?.status).toBe("suspended");
    expect(untouched?.deniedReason).toBeUndefined();
    expect(untouched?.claimedAt).toBeUndefined();

    // Only a caller the hook accepted may settle it.
    await expect(
      t.client.sendDirect("answers", { who: "alice", token }),
    ).rejects.toMatchObject({ rc: "RC5048" });
    expect((await store.get(`${record.id}-edited`))?.status).toBe("denied");
  });

  /**
   * @case An async hook that accepts resumes normally
   * @preconditions A hook that awaits before returning true
   * @expectedResult The continuation runs, so an async decision is a first-class one rather than a tolerated case
   */
  test("an async hook that accepts resumes the exchange", async () => {
    const store = new MemorySuspensionStore();
    const ran: unknown[] = [];
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .tap((ex) => {
            ran.push(ex.suspension.result);
          })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .resume(payloadFrom, {
            authorize: async () => {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return true;
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await t.client.sendDirect("answers", { token: parked.token });
    expect(ran).toEqual([{ approved: true }]);
    expect((await store.get(parked.suspensionId))?.status).toBe("resumed");
  });

  /**
   * @case A wrongly-bound credential learns nothing about a settled record
   * @preconditions A record already resumed, presented by a credential minted for a different call
   * @expectedResult The binding refusal, not the "duplicate" acknowledgment the rightful credential would receive
   */
  test("the binding check runs before the settled-state disclosure", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
        craft().id("answers").from(direct()).resume(payloadFrom),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    const record = (await store.get(parked.suspensionId)) as Suspension;
    await store.create({
      ...record,
      id: `${record.id}-bound`,
      callBinding: "call-winner",
      status: undefined,
      terminal: undefined,
      resumedAt: undefined,
      resumedBy: undefined,
      claimedAt: undefined,
      deniedReason: undefined,
    } as never);
    const runtime = t.ctx.getStore(SUSPENSION_RUNTIME)!;
    const winner = runtime.signer.mint(
      `${record.id}-bound`,
      new Date(),
      "call-winner",
    );
    const loser = runtime.signer.mint(
      `${record.id}-bound`,
      new Date(),
      "call-loser",
    );

    await t.client.sendDirect("answers", { token: winner });
    expect((await store.get(`${record.id}-bound`))?.status).toBe("resumed");

    // The winner would now read `duplicate`. The loser must not learn that.
    await expect(
      t.client.sendDirect("answers", { token: loser }),
    ).rejects.toMatchObject({ rc: "RC5055" });
  });

  /**
   * @case A wrongly-bound credential cannot settle a record whose route was edited
   * @preconditions A per-call record whose stored continuation hash no longer matches, presented by a losing sibling's credential
   * @expectedResult The binding refusal wins first, leaving the record unclaimed and undenied; only the rightful credential reaches the RC5048 re-ask
   */
  test("a wrongly-bound credential cannot burn a record on the hash arm", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
        craft().id("answers").from(direct()).resume(payloadFrom),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
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
    const loser = runtime.signer.mint(
      `${record.id}-bound`,
      new Date(),
      "call-loser",
    );
    const winner = runtime.signer.mint(
      `${record.id}-bound`,
      new Date(),
      "call-winner",
    );

    await expect(
      t.client.sendDirect("answers", { token: loser }),
    ).rejects.toMatchObject({ rc: "RC5055" });
    const untouched = await store.get(`${record.id}-bound`);
    expect(untouched?.status).toBe("suspended");
    expect(untouched?.deniedReason).toBeUndefined();
    expect(untouched?.claimedAt).toBeUndefined();

    await expect(
      t.client.sendDirect("answers", { token: winner }),
    ).rejects.toMatchObject({ rc: "RC5048" });
    expect((await store.get(`${record.id}-bound`))?.status).toBe("denied");
  });

  /**
   * @case False, a throw, and an unsettled hook are one refusal on the wire
   * @preconditions Three doors: one returning false, one throwing an internal detail, one never settling under a route timeout
   * @expectedResult All three answer the same RC5056 message, none leaks the cause, and the log distinguishes them
   */
  test("false, throw and abort are identical on the wire", async () => {
    const logged: Array<Record<string, unknown>> = [];
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
        craft()
          .id("says-no")
          .from(direct())
          .resume(payloadFrom, { authorize: () => false }),
        craft()
          .id("blows-up")
          .from(direct())
          .resume(payloadFrom, {
            authorize: () => {
              throw new Error("https://idp.internal/introspect refused");
            },
          }),
        craft()
          .id("never-settles")
          .from(direct())
          .timeout(30)
          .resume(payloadFrom, {
            authorize: () => new Promise<boolean>(() => {}),
          }),
      ])
      .build();
    await t.startAndWaitReady();
    t.ctx.logger.warn = ((bindings: Record<string, unknown>) => {
      logged.push(bindings);
    }) as unknown as CraftContext["logger"]["warn"];

    const messages: string[] = [];
    for (const door of ["says-no", "blows-up", "never-settles"]) {
      const parked = asSuspended(await t.client.sendDirect("payout", {}));
      try {
        await t.client.sendDirect(door, { token: parked.token });
        throw new Error(`expected ${door} to refuse`);
      } catch (err) {
        messages.push((err as Error).message);
      }
    }

    expect(messages[0]).toContain("refused this principal");
    expect(messages[1]).toContain("refused this principal");
    expect(messages[1]).not.toContain("idp.internal");
    // The route's own .timeout() is what bounds an unsettled hook, so the
    // caller may see either the refusal or the timeout; neither leaks.
    expect(messages[2]).not.toContain("idp.internal");

    const outcomes = logged.map((line) => line["outcome"]);
    expect(outcomes).toContain("returned false");
    expect(outcomes).toContain("threw");
    const threw = logged.find((line) => line["outcome"] === "threw");
    expect(String((threw?.["err"] as Error)?.message)).toContain(
      "idp.internal",
    );
  });

  /**
   * @case An answer that arrives in time but sits behind a slow hook reports the expiry
   * @preconditions A 30ms ttl and a hook that accepts only after the deadline has passed
   * @expectedResult RC5047, so the caller is told the window closed rather than that they were refused
   */
  test("the deadline is re-checked after an async hook", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval, ttl: "30ms" })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .resume(payloadFrom, {
            authorize: async () => {
              await new Promise((resolve) => setTimeout(resolve, 60));
              return true;
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await expect(
      t.client.sendDirect("answers", { token: parked.token }),
    ).rejects.toMatchObject({ rc: "RC5047" });
  });

  /**
   * @case The hook sees the record's metadata view and never the parked body
   * @preconditions A site attaching meta, over a body the hook must not receive
   * @expectedResult Exactly the documented fields arrive, meta round-trips verbatim, and nothing carries the body
   */
  test("meta round-trips from park to hook, without the body", async () => {
    const seen: unknown[] = [];
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({
            schema: Approval,
            meta: { channel: "finance", requires: ["payouts:approve"] },
          })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .resume(payloadFrom, {
            authorize: ({ record }) => {
              seen.push(record);
              return true;
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { secret: "do-not-leak" }),
    );
    await t.client.sendDirect("answers", { token: parked.token });

    const view = seen[0] as Record<string, unknown>;
    expect(view["meta"]).toEqual({
      channel: "finance",
      requires: ["payouts:approve"],
    });
    expect(view["routeId"]).toBe("payout");
    expect(view["suspendedAt"]).toBeInstanceOf(Date);
    expect(Object.keys(view).sort()).toEqual([
      "expiresAt",
      "id",
      "meta",
      "routeId",
      "suspendedAt",
    ]);
    expect(JSON.stringify(view)).not.toContain("do-not-leak");
  });

  /**
   * @case meta is subject to the same plain-JSON rule as the exchange
   * @preconditions A site attaching a function in meta
   * @expectedResult The park fails with RC5042 naming the slot, rather than writing a record the store cannot round-trip
   */
  test("meta refuses a value the store cannot round-trip", async () => {
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval, meta: { hook: () => true } })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("payout", {})).rejects.toMatchObject({
      rc: "RC5042",
    });
  });

  /**
   * @case The hook cannot transition anything before it decides
   * @preconditions A refusing hook over a store whose transitions are counted
   * @expectedResult The refusal lands with no compare-and-swap attempted
   */
  test("a refusal attempts no store transition", async () => {
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
          .suspend({ schema: Approval })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .resume(payloadFrom, { authorize: () => false }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await expect(
      t.client.sendDirect("answers", { token: parked.token }),
    ).rejects.toThrow(/refused this principal/);
    expect(transitions).toBe(0);
  });

  /**
   * @case .resume({ authorize }) refuses a value that cannot be a hook
   * @preconditions A non-function passed as authorize
   * @expectedResult RC5003 at build time, rather than a door that silently authorizes nothing
   */
  test("a non-function hook is refused at build time", () => {
    expect(() =>
      craft()
        .id("door")
        .from(direct())
        .resume({ authorize: "yes" as never })
        .build(),
    ).toThrow(/must be a function/);
  });
});

describe("the parked answer schema", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A site with no schema parks with no ingress contract at all
   * @preconditions .suspend() with no schema, resumed with a value no approval schema would accept
   * @expectedResult The park carries no schema rendering, the answer is delivered unvalidated, and the descriptor records the absence
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
        craft().id("answers").from(direct()).resume(payloadFrom),
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
   * @case Removing a static site's schema invalidates records parked under it
   * @preconditions A record parked with a declared schema, then a redeploy whose site declares none
   * @expectedResult RC5048, because a static site always describes what it declares today: falling back to the stored descriptor would compare it against itself and accept the parked answer unvalidated
   */
  test("a removed static schema takes the RC5048 re-ask", async () => {
    const store = new MemorySuspensionStore();
    let t2: TestContext | undefined;
    const withSchema = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await withSchema.startAndWaitReady();
    const parked = asSuspended(
      await withSchema.client.sendDirect("payout", {}),
    );
    await withSchema.stop();

    try {
      t2 = await testContext()
        .with(shared(store))
        .routes([
          craft().id("payout").from(direct()).suspend({}).to(noop()),
          craft().id("answers").from(direct()).resume(payloadFrom),
        ])
        .build();
      await t2.startAndWaitReady();
      await expect(
        t2.client.sendDirect("answers", { token: parked.token }),
      ).rejects.toMatchObject({ rc: "RC5048" });
    } finally {
      if (t2) await t2.stop();
    }
  });

  /**
   * @case The absent-schema descriptor is distinct from the degraded fallback
   * @preconditions A site with no schema, and a schema advertising a JSON Schema extension that produces nothing
   * @expectedResult Two different hashes, so editing a site between the two states moves the continuation digest and takes the re-ask
   */
  test("absent and degraded schema descriptors differ", () => {
    const degraded = {
      "~standard": {
        version: 1,
        vendor: "hostile",
        validate: (value: unknown) => ({ value }),
        jsonSchema: { input: () => undefined, output: () => undefined },
      },
    } as never;

    const absent = describeSchema(undefined);
    const advertised = describeSchema(degraded);
    expect(absent.absent).toBe(true);
    expect(advertised.degraded).toBe(true);
    expect(absent.hash).not.toBe(advertised.hash);
  });

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

    const base = { status: "suspended", suspensionId: "s-1", token: "t-1" };
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
  /**
   * @case The hook is handed the submission exactly as it arrived, before validation
   * @preconditions A site declaring a schema, resumed with a payload that would coerce or fail under it
   * @expectedResult The hook sees the verbatim value, not the schema's output, so a policy reading it reasons about what was actually sent
   */
  test("the hook sees the raw pre-validation payload", async () => {
    const seen: unknown[] = [];
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
        craft()
          .id("approvals")
          .from(direct())
          .resume(payloadFrom, {
            authorize: ({ payload }) => {
              seen.push(payload);
              return true;
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    // Extra keys the schema strips, so seeing them proves the hook ran first.
    await t.client.sendDirect("approvals", {
      token: parked.token,
      result: { approved: true, note: "sent from the approval mail" },
    });

    expect(seen[0]).toEqual({
      approved: true,
      note: "sent from the approval mail",
    });
  });

  /**
   * @case A refused submission never reaches validation or the claim
   * @preconditions A malformed payload the schema would reject, presented by a principal the hook refuses
   * @expectedResult RC5056 rather than RC5049, and the record is left suspended, so the refusal is decided without the validator ever seeing the value
   */
  test("a hook-refused malformed payload never reaches validation", async () => {
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
          .id("approvals")
          .from(direct())
          .authenticate(asWho)
          .resume(payloadFrom, {
            authorize: ({ principal }) => principal?.subject === "alice",
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await expect(
      t.client.sendDirect("approvals", {
        who: "mallory",
        token: parked.token,
        result: "not an approval object at all",
      }),
    ).rejects.toMatchObject({ rc: "RC5056" });
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");

    // The same malformed payload from the principal the hook accepts DOES
    // reach the validator, which is what proves the refusal above was the
    // hook's and not the schema's.
    await expect(
      t.client.sendDirect("approvals", {
        who: "alice",
        token: parked.token,
        result: "not an approval object at all",
      }),
    ).rejects.toMatchObject({ rc: "RC5049" });
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");
  });

  /**
   * @case A rejected payload does not consume the single-use link
   * @preconditions A resume whose payload fails the declared schema, followed by a correct one on the same token
   * @expectedResult RC5049 leaves the record suspended and undenied, and the corrected submission still resumes it
   */
  test("RC5049 leaves the link unspent", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
        craft().id("approvals").from(direct()).resume(payloadFrom),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await expect(
      t.client.sendDirect("approvals", {
        token: parked.token,
        result: { approved: "yes please" },
      }),
    ).rejects.toMatchObject({ rc: "RC5049" });
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");

    await t.client.sendDirect("approvals", {
      token: parked.token,
      result: { approved: true },
    });
    expect((await store.get(parked.suspensionId))?.status).toBe("resumed");
  });
  /**
   * @case tokenFor refuses to mint an unbound credential for an untyped caller
   * @preconditions A step reading ex.suspension.tokenFor through a loosely typed boundary and passing no binding
   * @expectedResult RC5003 at the mint site, rather than a link that would later refuse every resume with RC5055 and point at its holder
   */
  test("tokenFor refuses a missing call binding", async () => {
    let thrown: unknown;
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .tap((ex) => {
            const loose = ex.suspension as unknown as {
              tokenFor: (binding?: string) => string;
            };
            try {
              loose.tokenFor();
            } catch (err) {
              thrown = err;
            }
          })
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();
    await t.client.sendDirect("payout", {});

    expect(thrown).toMatchObject({ rc: "RC5003" });
  });
});
