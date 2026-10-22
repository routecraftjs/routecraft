import { afterEach, describe, expect, mock, test } from "bun:test";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  MemoryCacheProvider,
  noop,
} from "@routecraft/routecraft";

/**
 * `.cache({ when })`: the per-exchange condition beside `key`. A false
 * `when` sits the cache out for that exchange, both the read and the write,
 * at route scope and at step scope alike.
 */
describe(".cache({ when })", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /** Every cache event name emitted on the context, in order. */
  function captureCacheEvents(ctx: TestContext): string[] {
    const events: string[] = [];
    for (const name of [
      "hit",
      "miss",
      "stored",
      "failed",
      "bypassed",
    ] as const) {
      ctx.ctx.on(`route:cache:${name}` as never, () => {
        events.push(name);
      });
    }
    return events;
  }

  /**
   * @case Route scope: a false `when` neither reads nor writes, and the pipeline runs every time
   * @preconditions craft().cache({ provider, when: body !== "fresh" }).from(direct()); two sends of "fresh" and two of "stale"
   * @expectedResult "fresh" runs the pipeline twice and touches the provider for neither a read nor a write; "stale" runs once and hits once; the bypassed sends emit route:cache:bypassed and no hit, miss or stored
   */
  test("route scope skips the read and the write when the condition is false", async () => {
    const provider = new MemoryCacheProvider();
    const reads = mock(provider.get.bind(provider));
    const writes = mock(provider.set.bind(provider));
    provider.get = reads;
    provider.set = writes;
    const compute = mock((b: string) => `out:${b}`);
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-when")
          .cache({
            provider,
            when: (ex) => ex.body !== "fresh",
          })
          .from<string>(direct())
          .transform(compute)
          .to(sink),
      )
      .build();
    const events = captureCacheEvents(t);

    await t.startAndWaitReady();
    await t.client.sendDirect("route-cache-when", "fresh");
    await t.client.sendDirect("route-cache-when", "fresh");
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    await t.client.sendDirect("route-cache-when", "stale");
    const hit = await t.client.sendDirect("route-cache-when", "stale");

    expect(compute).toHaveBeenCalledTimes(3);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(hit).toBe("out:stale");
    expect(sink.received.map((ex) => ex.body)).toEqual([
      "out:fresh",
      "out:fresh",
      "out:stale",
    ]);
    expect(events).toEqual(["bypassed", "bypassed", "miss", "stored", "hit"]);
  });

  /**
   * @case Step scope: a false `when` runs the wrapped step and stores nothing
   * @preconditions .from(direct()).cache({ provider, when: body !== "fresh" }).transform(compute); two sends of "fresh" and two of "stale"
   * @expectedResult compute runs three times; the bypassed sends emit route:cache:bypassed with scope "step" and nothing else
   */
  test("step scope skips the cache when the condition is false", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: string) => `out:${b}`);

    t = await testContext()
      .routes(
        craft()
          .id("step-cache-when")
          .from<string>(direct())
          .cache({ provider, when: (ex) => ex.body !== "fresh" })
          .transform(compute)
          .to(noop()),
      )
      .build();
    const scopes: string[] = [];
    t.ctx.on(
      "route:cache:bypassed" as never,
      (payload: { details: { scope: string } }) => {
        scopes.push(payload.details.scope);
      },
    );
    const events = captureCacheEvents(t);

    await t.startAndWaitReady();
    await t.client.sendDirect("step-cache-when", "fresh");
    await t.client.sendDirect("step-cache-when", "fresh");
    await t.client.sendDirect("step-cache-when", "stale");
    await t.client.sendDirect("step-cache-when", "stale");

    expect(compute).toHaveBeenCalledTimes(3);
    expect(scopes).toEqual(["step", "step"]);
    expect(events).toEqual(["bypassed", "bypassed", "miss", "stored", "hit"]);
  });

  /**
   * @case A `when` that throws fails the exchange as RC5069 and reports the phase
   * @preconditions Route-scope cache whose `when` throws for every exchange
   * @expectedResult sendDirect rejects with RC5069; route:cache:failed carries phase "when"; the pipeline never ran
   */
  test("a throwing condition fails the exchange with RC5069 and phase when", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: string) => `out:${b}`);
    const phases: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-when-throws")
          .cache({
            provider,
            when: () => {
              throw new Error("undecidable");
            },
          })
          .from<string>(direct())
          .transform(compute)
          .to(noop()),
      )
      .build();
    t.ctx.on(
      "route:cache:failed" as never,
      (payload: { details: { phase: string } }) => {
        phases.push(payload.details.phase);
      },
    );

    await t.startAndWaitReady();
    await expect(
      t.client.sendDirect("route-cache-when-throws", "x"),
    ).rejects.toMatchObject({ rc: "RC5069" });

    expect(compute).not.toHaveBeenCalled();
    expect(phases).toEqual(["when"]);
  });

  /**
   * @case A false `when` is decided before the key, so an unkeyable body never reaches key derivation
   * @preconditions Route-scope cache with the default key and `when: () => false`; the body is a function, which the default key cannot serialise
   * @expectedResult The send succeeds with the pipeline's result instead of failing with RC5029
   */
  test("a false condition runs before the key is derived", async () => {
    const provider = new MemoryCacheProvider();
    t = await testContext()
      .routes(
        craft()
          .id("route-cache-when-unkeyable")
          .cache({ provider, when: () => false })
          .from<unknown>(direct())
          .transform(() => "ran")
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    await expect(
      t.client.sendDirect("route-cache-when-unkeyable", () => undefined),
    ).resolves.toBe("ran");
  });

  /**
   * @case A `when` that returns a promise is refused rather than read as truthy
   * @preconditions Route-scope cache whose `when` is an async function
   * @expectedResult sendDirect rejects with RC5069; the pipeline never ran
   */
  test("a condition returning a promise fails the exchange with RC5069", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: string) => `out:${b}`);

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-when-async")
          .cache({
            provider,
            // A rejecting promise: the refusal must not leave it unhandled.
            when: (() =>
              Promise.reject(new Error("later"))) as unknown as () => boolean,
          })
          .from<string>(direct())
          .transform(compute)
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    await expect(
      t.client.sendDirect("route-cache-when-async", "x"),
    ).rejects.toMatchObject({ rc: "RC5069" });
    expect(compute).not.toHaveBeenCalled();
  });

  /**
   * @case Without `when` the cache behaves as before
   * @preconditions Route-scope cache with no condition; two identical sends
   * @expectedResult One miss, one stored, one hit; no bypassed event
   */
  test("no condition means the cache always takes part", async () => {
    const provider = new MemoryCacheProvider();

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-no-when")
          .cache({ provider })
          .from<string>(direct())
          .transform((b: string) => `out:${b}`)
          .to(noop()),
      )
      .build();
    const events = captureCacheEvents(t);

    await t.startAndWaitReady();
    await t.client.sendDirect("route-cache-no-when", "x");
    await t.client.sendDirect("route-cache-no-when", "x");

    expect(events).toEqual(["miss", "stored", "hit"]);
  });
});
