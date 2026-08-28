import { describe, test, expect, afterEach } from "bun:test";
import {
  bootServer,
  type BootedServer,
  type TestContext,
  type TestContextBuilder,
} from "@routecraft/testing";
import {
  apiKey,
  craft,
  http,
  noop,
  type CraftConfig,
  type HttpPluginOptions,
  type Principal,
} from "@routecraft/routecraft";

/**
 * The two bounds a streaming listener carries, and the one authority it
 * cannot outlive.
 *
 * A streaming response is exempt from the idle reaper, which is the only
 * thing that otherwise limits how long a connection may sit open, so the
 * exemption has to come with a ceiling of its own. And admission is checked
 * once, which on an ordinary request covers the whole request and on a stream
 * would otherwise cover an unbounded window.
 */

interface BootOptions {
  routes: Parameters<TestContextBuilder["routes"]>[0];
  server?: Record<string, unknown>;
  http?: HttpPluginOptions;
}

async function boot(opts: BootOptions): Promise<BootedServer> {
  return await bootServer((builder) =>
    builder.routes(opts.routes).with({
      servers: { default: { port: 0, host: "127.0.0.1", ...opts.server } },
      http: opts.http ?? {},
    } as CraftConfig),
  );
}

/** An endless stream, so a slot stays taken until the caller lets go. */
const endless = () =>
  craft()
    .id("endless")
    .from(http({ path: "/endless", method: "GET" }))
    .transform(async function* () {
      for (;;) {
        yield { data: "tick" };
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })
    .to(noop());

describe("streaming listener bounds", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A listener at its streaming cap refuses rather than opening another
   * @preconditions maxStreamingRequests is 1; two clients ask for the same endless stream
   * @expectedResult The first streams, the second gets 503 with Retry-After
   */
  test("refuses past maxStreamingRequests with 503", async () => {
    const bound = await boot({
      routes: endless(),
      server: { maxStreamingRequests: 1 },
    });
    t = bound.ctx;

    const first = new AbortController();
    const open = await fetch(`http://127.0.0.1:${bound.port}/endless`, {
      signal: first.signal,
    });
    expect(open.status).toBe(200);
    await open.body!.getReader().read();

    const refused = await fetch(`http://127.0.0.1:${bound.port}/endless`);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(await refused.json()).toMatchObject({
      reason: "streaming_capacity",
    });

    first.abort();
  });

  /**
   * @case A released slot is reusable, so the cap bounds concurrency and not lifetime
   * @preconditions maxStreamingRequests is 1; the first stream is finished before the second asks
   * @expectedResult The second request is served, proving the slot was returned
   */
  test("a finished stream returns its slot", async () => {
    const bound = await boot({
      routes: craft()
        .id("brief")
        .from(http({ path: "/brief", method: "GET" }))
        .transform(async function* () {
          yield { data: "only" };
        })
        .to(noop()),
      server: { maxStreamingRequests: 1 },
    });
    t = bound.ctx;

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`http://127.0.0.1:${bound.port}/brief`);
      expect(res.status).toBe(200);
      await res.text();
    }
  });

  /**
   * @case An idleTimeout above Bun's ceiling fails the boot rather than being clamped
   * @preconditions servers.default.idleTimeout is "600s"
   * @expectedResult Build throws RC5003 naming the platform limit, so one config cannot mean two things
   */
  test("an idleTimeout above the platform ceiling is refused", async () => {
    await expect(
      boot({ routes: endless(), server: { idleTimeout: "600s" } }),
    ).rejects.toThrow(/255s|255000ms/);
  });

  /**
   * @case A stream closes when the credential that admitted it expires
   * @preconditions An api key whose principal carries an expiresAt one second out
   * @expectedResult The response body ends on its own, without the client asking
   */
  test("a stream closes when its credential expires", async () => {
    const bound = await boot({
      routes: endless(),
      http: {
        auth: apiKey({
          verify: (): Principal => ({
            kind: "custom",
            scheme: "apiKey",
            subject: "shortlived",
            expiresAt: Math.floor(Date.now() / 1000) + 1,
          }),
        }),
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/endless`, {
      headers: { "x-api-key": "anything" },
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const closedBy = Date.now() + 5000;
    let closed = false;
    while (Date.now() < closedBy) {
      const step = await reader.read();
      if (step.done) {
        closed = true;
        break;
      }
    }
    expect(closed).toBe(true);
  });
});
