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
 * Cross-runtime contract for streaming response bodies on the http source.
 *
 * The two servers carry the bytes differently: `Bun.serve` streams a
 * stream-bodied `Response` natively, while the `node:http` shim pumps the
 * body reader chunk by chunk and cancels it on client abort. Framing,
 * disconnect propagation and the deferred per-request event must look the
 * same from the client either way, so they are proven here on whichever
 * server path the current runtime selects.
 */

const decoder = new TextDecoder();

async function bootHttp(
  routes: Parameters<ReturnType<typeof testContext>["routes"]>[0],
  events?: Partial<Record<EventName, (ev: { details: unknown }) => void>>,
): Promise<{ ctx: TestContext; port: number }> {
  let port = 0;
  const builder = testContext()
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
    } as CraftConfig);
  for (const [name, handler] of Object.entries(events ?? {})) {
    builder.on(
      name as EventName,
      handler as Parameters<ReturnType<typeof testContext>["on"]>[1],
    );
  }
  const ctx = await builder.build();
  await ctx.startAndWaitReady();
  expect(port).toBeGreaterThan(0);
  return { ctx, port };
}

async function until(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("http source SSE streaming (cross-runtime contract)", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  /**
   * @case An SSE route delivers its frames incrementally on both servers
   * @preconditions Generator yields three descriptors with a pause between them
   * @expectedResult text/event-stream with no-cache, and the first frame arrives before the last is produced
   */
  test("SSE frames stream out incrementally", async () => {
    const bound = await bootHttp(
      craft()
        .id("cross-sse")
        .from(http({ path: "/cross-sse", method: "GET" }))
        .transform(async function* () {
          for (let n = 0; n < 3; n++) {
            yield { event: "tick", data: { n } };
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
        })
        .to(noop()),
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/cross-sse`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('event: tick\ndata: {"n":0}\n\n');

    let rest = "";
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      rest += decoder.decode(step.value);
    }
    expect(rest).toBe(
      'event: tick\ndata: {"n":1}\n\nevent: tick\ndata: {"n":2}\n\n',
    );
  });

  /**
   * @case A client disconnect reaches the route's iterator on both servers
   * @preconditions Endless generator with a finally block; the caller aborts mid-stream
   * @expectedResult The generator's finally runs, so the producer stops rather than leaking
   */
  test("aborting the request cancels the route's iterator", async () => {
    let closed = false;
    const bound = await bootHttp(
      craft()
        .id("cross-endless")
        .from(http({ path: "/cross-endless", method: "GET" }))
        .transform(async function* () {
          try {
            for (let n = 0; ; n++) {
              yield { data: n };
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          } finally {
            closed = true;
          }
        })
        .to(noop()),
    );
    t = bound.ctx;

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${bound.port}/cross-endless`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();

    await until(() => closed);
    expect(closed).toBe(true);
  });

  /**
   * @case The per-request event waits for the stream on both servers
   * @preconditions Generator pauses between two frames; the caller drains the body
   * @expectedResult One completed event, status 200, durationMs covering the pause
   */
  test("the completed event fires when the stream closes", async () => {
    const events: Array<{ path: string; status: number; durationMs: number }> =
      [];
    const bound = await bootHttp(
      craft()
        .id("cross-slow")
        .from(http({ path: "/cross-slow", method: "GET" }))
        .transform(async function* () {
          yield { data: "one" };
          await new Promise((resolve) => setTimeout(resolve, 120));
          yield { data: "two" };
        })
        .to(noop()),
      {
        "plugin:http:request:completed": (ev) => {
          events.push(
            ev.details as { path: string; status: number; durationMs: number },
          );
        },
      },
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/cross-slow`);
    expect(await res.text()).toBe("data: one\n\ndata: two\n\n");

    await until(() => events.some((e) => e.path === "/cross-slow"));
    const completed = events.find((e) => e.path === "/cross-slow");
    expect(completed).toBeDefined();
    expect(completed!.status).toBe(200);
    expect(completed!.durationMs).toBeGreaterThanOrEqual(100);
  });
});
