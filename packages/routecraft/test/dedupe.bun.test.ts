import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  DedupeStep,
  markAuthentic,
  RoutecraftError,
  type Exchange,
  type Principal,
  type Source,
  principalOf,
} from "@routecraft/routecraft";

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A bearer principal for `subject` at the test issuer, optionally acting through `actor`. */
function principal(subject: string, actor?: string): Principal {
  return {
    kind: "custom",
    scheme: "bearer",
    issuer: "https://idp.test",
    subject,
    ...(actor
      ? {
          actor: {
            kind: "custom",
            scheme: "bearer",
            issuer: "https://agents.test",
            subject: actor,
          },
        }
      : {}),
  };
}

/** A source that emits the same body once per principal, in order. */
function sameBodyFrom(principals: Principal[]): Source<string> {
  return {
    subscribe: async (sub) => {
      for (const p of principals) {
        await sub.emit({
          message: "same",
          headers: { "routecraft.auth.principal": markAuthentic(p) },
        });
      }
    },
  };
}

/**
 * Send through a direct route, tolerating the `RC5031` that a request/reply
 * caller sees when the route drops the exchange (a deduplicated exchange has
 * no response body). Any other failure propagates.
 */
async function send(
  t: TestContext,
  routeId: string,
  body: unknown,
): Promise<void> {
  try {
    await t.client.sendDirect(routeId, body);
  } catch (err) {
    if (err instanceof RoutecraftError && err.rc === "RC5031") return;
    throw err;
  }
}

describe("dedupe (.dedupe())", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case A committed key suppresses later identical exchanges
   * @preconditions Route with .dedupe() (default body hash); two sequential sends of the same body
   * @expectedResult The first send is processed; the second is dropped as a duplicate
   */
  test("commits on completion and drops the next duplicate", async () => {
    let runs = 0;
    const s = spy();
    t = await testContext()
      .routes(
        craft()
          .id("dedupe-commit")
          .from(direct())
          .dedupe()
          .transform((body) => {
            runs++;
            return body;
          })
          .to(s),
      )
      .build();
    await t.startAndWaitReady();

    await send(t, "dedupe-commit", { event: "a" });
    await send(t, "dedupe-commit", { event: "a" });

    expect(t.errors).toHaveLength(0);
    expect(runs).toBe(1);
    expect(s.received).toHaveLength(1);
  });

  /**
   * @case Distinct bodies derive distinct keys and all pass
   * @preconditions Route with .dedupe() over three sequential sends: a, a, b
   * @expectedResult Two exchanges reach the destination (the first a and the b)
   */
  test("default key distinguishes different bodies", async () => {
    const s = spy();
    t = await testContext()
      .routes(craft().id("dedupe-body").from(direct()).dedupe().to(s))
      .build();
    await t.startAndWaitReady();

    await send(t, "dedupe-body", { v: 1 });
    await send(t, "dedupe-body", { v: 1 });
    await send(t, "dedupe-body", { v: 2 });

    expect(s.received.map((e) => e.body)).toEqual([{ v: 1 }, { v: 2 }]);
  });

  /**
   * @case An explicit key dedupes on derived identity, not the whole body
   * @preconditions Route with .dedupe({ key: e => String(e.body.id) }); sends {id:1,..}, {id:1,..}, {id:2}
   * @expectedResult The two id:1 exchanges collapse to one; id:2 passes
   */
  test("explicit key derives identity from a field", async () => {
    const s = spy();
    t = await testContext()
      .routes(
        craft()
          .id("dedupe-key")
          .from(direct())
          .dedupe({
            key: (e: Exchange) => String((e.body as { id: number }).id),
          })
          .to(s),
      )
      .build();
    await t.startAndWaitReady();

    await send(t, "dedupe-key", { id: 1, v: "x" });
    await send(t, "dedupe-key", { id: 1, v: "y" });
    await send(t, "dedupe-key", { id: 2, v: "z" });

    expect(s.received.map((e) => (e.body as { id: number }).id)).toEqual([
      1, 2,
    ]);
  });

  /**
   * @case A failed exchange releases its reservation so a re-send may retry
   * @preconditions Route with .dedupe() then a processor that always throws; two sequential sends of the same body
   * @expectedResult Both sends reach the processor (the key is released on failure, not committed)
   */
  test("releases the reservation on failure", async () => {
    let runs = 0;
    t = await testContext()
      .routes(
        craft()
          .id("dedupe-release")
          .from(direct())
          .dedupe()
          .transform(() => {
            runs++;
            throw new Error("boom");
          })
          .to(spy()),
      )
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("dedupe-release", { event: "a" }),
    ).rejects.toThrow();
    await expect(
      t.client.sendDirect("dedupe-release", { event: "a" }),
    ).rejects.toThrow();

    // Both reached the processor: the first failure released the key, so the
    // second send was not suppressed as a duplicate.
    expect(runs).toBe(2);
  });

  /**
   * @case An exchange dropped by a downstream step releases its reservation (not committed)
   * @preconditions Route with .dedupe() then a filter; the same body is sent while the filter drops, then again once it passes
   * @expectedResult The re-send is reprocessed (the downstream drop did not permanently commit the key)
   */
  test("releases the reservation on a downstream drop", async () => {
    let filterPasses = false;
    const s = spy();
    t = await testContext()
      .routes(
        craft()
          .id("dedupe-drop-release")
          .from(direct())
          .dedupe()
          .filter(() => filterPasses)
          .to(s),
      )
      .build();
    await t.startAndWaitReady();

    // First send: dedupe reserves, the filter drops it -> reservation released.
    await send(t, "dedupe-drop-release", { event: "a" });
    expect(s.received).toHaveLength(0);

    // Re-send the identical body once the filter admits it: because the drop
    // released the key (rather than committing it), this is not suppressed.
    filterPasses = true;
    await send(t, "dedupe-drop-release", { event: "a" });

    expect(s.received).toHaveLength(1);
  });

  /**
   * @case A throwing custom key function surfaces RC5033, not a bare error
   * @preconditions Route with .dedupe({ key }) whose key function throws
   * @expectedResult The send rejects with RC5033, matching the default-key contract
   */
  test("wraps a throwing custom key in RC5033", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("dedupe-key-throws")
          .from(direct())
          .dedupe({
            key: () => {
              throw new Error("key boom");
            },
          })
          .to(spy()),
      )
      .build();
    await t.startAndWaitReady();

    const err = await t.client
      .sendDirect("dedupe-key-throws", { event: "a" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoutecraftError);
    expect((err as RoutecraftError).rc).toBe("RC5033");
  });

  /**
   * @case A committed key expires after its ttl and the next occurrence passes
   * @preconditions Route with .dedupe({ ttl: 40 }); send a, send a (dropped), sleep 60ms, send a
   * @expectedResult The first and the post-expiry send pass; the in-ttl duplicate is dropped
   */
  test("ttl expiry re-admits a previously seen key", async () => {
    const s = spy();
    t = await testContext()
      .routes(craft().id("dedupe-ttl").from(direct()).dedupe({ ttl: 40 }).to(s))
      .build();
    await t.startAndWaitReady();

    await send(t, "dedupe-ttl", { event: "a" });
    await send(t, "dedupe-ttl", { event: "a" });
    await sleep(60);
    await send(t, "dedupe-ttl", { event: "a" });

    expect(s.received).toHaveLength(2);
  });

  /**
   * @case Dedupe emits pass/duplicate operation events carrying the derived key
   * @preconditions Route with .dedupe(); two sequential sends of the same body; subscribers registered
   * @expectedResult One route:operation:dedupe:pass and one :duplicate, both carrying the same key
   */
  test("emits route:operation:dedupe:pass and :duplicate", async () => {
    const pass: { key: string }[] = [];
    const dup: { key: string }[] = [];
    const s = spy();
    t = await testContext()
      .on("route:operation:dedupe:pass", (p) => {
        pass.push(p.details as { key: string });
      })
      .on("route:operation:dedupe:duplicate", (p) => {
        dup.push(p.details as { key: string });
      })
      .routes(craft().id("dedupe-events").from(direct()).dedupe().to(s))
      .build();
    await t.startAndWaitReady();

    await send(t, "dedupe-events", { event: "a" });
    await send(t, "dedupe-events", { event: "a" });

    expect(pass).toHaveLength(1);
    expect(dup).toHaveLength(1);
    expect(dup[0]!.key).toBe(pass[0]!.key);
  });

  /**
   * @case A non-serialisable body with no key function fails loudly
   * @preconditions Route with .dedupe() (default key); body containing a BigInt
   * @expectedResult The send rejects with RC5033 (dedupe key derivation failed)
   */
  test("throws RC5033 for an unsupported body without a key", async () => {
    t = await testContext()
      .routes(
        craft().id("dedupe-unsupported").from(direct()).dedupe().to(spy()),
      )
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("dedupe-unsupported", { big: 1n }),
    ).rejects.toThrow(/RC5033|serialisable|dedupe key/i);
  });

  /**
   * @case An undefined body with no key function fails with a message saying there is nothing to key on
   * @preconditions Route with .dedupe() (default key); a send whose body is undefined
   * @expectedResult The send rejects with RC5033 naming the undefined body, not a serialisation failure
   */
  test("throws RC5033 for an undefined body without a key", async () => {
    t = await testContext()
      .routes(craft().id("dedupe-bodiless").from(direct()).dedupe().to(spy()))
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("dedupe-bodiless", undefined),
    ).rejects.toThrow(/nothing to key on/);
  });

  /**
   * @case The default key separates principals sending the same body
   * @preconditions Route with .dedupe() (default key); the source emits the same body as alice, then bob
   * @expectedResult Both exchanges are processed: bob is not a duplicate of alice
   */
  test("default key keeps different principals apart", async () => {
    const s = spy();
    t = await testContext()
      .routes(
        craft()
          .id("dedupe-principals")
          .from(sameBodyFrom([principal("alice"), principal("bob")]))
          .dedupe()
          .to(s),
      )
      .build();
    await t.test();

    expect(s.received.map((e) => principalOf(e)?.subject)).toEqual([
      "alice",
      "bob",
    ]);
  });

  /**
   * @case The default key still dedupes one principal's repeat
   * @preconditions Route with .dedupe() (default key); the source emits the same body as alice, alice, then bob
   * @expectedResult alice's repeat is dropped and bob passes, so two exchanges are processed
   */
  test("default key dedupes the same principal", async () => {
    const s = spy();
    t = await testContext()
      .routes(
        craft()
          .id("dedupe-same-principal")
          .from(
            sameBodyFrom([
              principal("alice"),
              principal("alice"),
              principal("bob"),
            ]),
          )
          .dedupe()
          .to(s),
      )
      .build();
    await t.test();

    expect(s.received.map((e) => principalOf(e)?.subject)).toEqual([
      "alice",
      "bob",
    ]);
  });

  /**
   * @case The default key separates delegates acting for the same subject
   * @preconditions Route with .dedupe() (default key); the source emits the same body as alice via agent-1, via agent-2, then via agent-1 again
   * @expectedResult agent-2 passes and agent-1's repeat is dropped, so two exchanges are processed
   */
  test("default key keeps delegates for one subject apart", async () => {
    const s = spy();
    t = await testContext()
      .routes(
        craft()
          .id("dedupe-actors")
          .from(
            sameBodyFrom([
              principal("alice", "agent-1"),
              principal("alice", "agent-2"),
              principal("alice", "agent-1"),
            ]),
          )
          .dedupe()
          .to(s),
      )
      .build();
    await t.test();

    expect(s.received.map((e) => principalOf(e)?.actor?.subject)).toEqual([
      "agent-1",
      "agent-2",
    ]);
  });

  /**
   * @case The default key terminates on a self-referential actor chain and keeps it apart from the actorless principal
   * @preconditions Route with .dedupe() (default key); the source emits the same body twice under a principal whose actor is itself, then once under the same issuer and subject with no actor
   * @expectedResult Key derivation completes; the cyclic repeat is dropped and the actorless principal passes, so two exchanges are processed
   */
  test("default key handles a self-referential actor chain", async () => {
    const cyclic: Principal & { actor?: Principal } = principal("alice");
    cyclic.actor = cyclic;
    const s = spy();
    t = await testContext()
      .routes(
        craft()
          .id("dedupe-cyclic-actor")
          .from(sameBodyFrom([cyclic, cyclic, principal("alice")]))
          .dedupe()
          .to(s),
      )
      .build();
    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(s.received.map((e) => principalOf(e)?.actor !== undefined)).toEqual([
      true,
      false,
    ]);
  });

  /**
   * @case A custom key is used verbatim, so callers returning the same key dedupe each other
   * @preconditions Route with .dedupe({ key: () => "shared" }); the source emits the same body as alice, then bob
   * @expectedResult bob is dropped as a duplicate of alice
   */
  test("a custom key is not namespaced by principal", async () => {
    const s = spy();
    t = await testContext()
      .routes(
        craft()
          .id("dedupe-custom-shared")
          .from(sameBodyFrom([principal("alice"), principal("bob")]))
          .dedupe({ key: () => "shared" })
          .to(s),
      )
      .build();
    await t.test();

    expect(s.received.map((e) => principalOf(e)?.subject)).toEqual(["alice"]);
  });

  /**
   * @case Invalid options are rejected at build time
   * @preconditions DedupeStep constructed with a non-positive ttl or an out-of-range maxKeys
   * @expectedResult Each construction throws (RC5003)
   */
  test("rejects invalid options at build time", () => {
    expect(() => new DedupeStep({ ttl: 0 })).toThrow(/ttl/);
    expect(() => new DedupeStep({ ttl: -5 })).toThrow(/ttl/);
    expect(() => new DedupeStep({ maxKeys: 0 })).toThrow(/maxKeys/);
    expect(() => new DedupeStep({ maxKeys: 1.5 })).toThrow(/maxKeys/);
  });
});
