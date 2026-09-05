import { describe, test, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  http,
  noop,
  type CraftConfig,
  type EventName,
} from "@routecraft/routecraft";

/**
 * Cross-runtime contract for `http({ respond })`.
 *
 * The option changes when the response is written relative to the pipeline,
 * and the two server engines differ underneath it: `Bun.serve` returns a
 * `Response` the runtime writes, while the node:http shim copies status,
 * headers and body onto a `ServerResponse`. Two behaviours have to be proven
 * identical rather than assumed.
 *
 * The first is a genuine divergence the framework normalises. `new Response`
 * with a body on a status that forbids one (204, 205, 304, 101) is accepted by
 * Bun and throws `TypeError` on Node, so a responder returning `{ status: 204,
 * body }` would serve on one runtime and 500 on the other. The dispatcher drops
 * the body for those statuses; without that the same route behaves differently
 * per runtime, which the bun-only suite cannot see.
 *
 * The second is that answering early actually releases the caller on both
 * engines: the response must arrive while the pipeline is still parked, rather
 * than the runtime holding the socket until the handler's work finishes.
 */

async function bootHttp(
  routes: Parameters<ReturnType<typeof testContext>["routes"]>[0],
): Promise<{ ctx: TestContext; port: number }> {
  let port = 0;
  const ctx = await testContext()
    .on(
      "server:listening" as EventName,
      ((payload: { details: unknown }) => {
        port = (payload.details as { port: number }).port;
      }) as Parameters<ReturnType<typeof testContext>["on"]>[1],
    )
    .routes(routes)
    .with({
      servers: { default: { host: "127.0.0.1", port: 0 } },
      http: { server: "default" },
    } as CraftConfig)
    .build();
  await ctx.startAndWaitReady();
  expect(port).toBeGreaterThan(0);
  return { ctx, port };
}

describe("http source respond (cross-runtime contract)", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  /**
   * @case A status that forbids a body answers identically on both engines
   * @preconditions A responder returning `{ status: 204, body }`, which `new Response` accepts under Bun and rejects with a TypeError under Node
   * @expectedResult 204 with an empty body on whichever runtime is executing, so the framework's normalisation is what both engines agree on rather than the platform's own behaviour
   */
  test("a 204 descriptor with a body answers 204 on both runtimes", async () => {
    const bound = await bootHttp(
      craft()
        .id("cross-null-body")
        .from(
          http({
            path: "/hooks/204",
            method: "POST",
            respond: () => ({ status: 204, body: { ignored: true } }),
          }),
        )
        .to(noop()),
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/204`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  /**
   * @case The caller is released before the pipeline finishes on both engines
   * @preconditions A responder answering 202 without awaiting `finished`, on a route whose step parks on a promise the test resolves only after asserting the response
   * @expectedResult The response is in hand while the step is still parked, proving neither engine holds the socket open until the handler's work completes
   */
  test("an early answer reaches the caller while the pipeline is parked", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stepFinished = false;

    const bound = await bootHttp(
      craft()
        .id("cross-early-answer")
        .from(
          http({
            path: "/hooks/early",
            method: "POST",
            respond: () => ({ status: 202 }),
          }),
        )
        .process(async (ex) => {
          await gate;
          stepFinished = true;
          return ex;
        })
        .to(noop()),
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/early`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1" }),
    });

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(stepFinished).toBe(false);

    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stepFinished).toBe(true);
  });
});
