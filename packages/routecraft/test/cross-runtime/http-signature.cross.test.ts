import { describe, test, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  http,
  noop,
  DefaultExchange,
  type CraftConfig,
  type EventName,
} from "@routecraft/routecraft";

/**
 * Cross-runtime contract for the http source's raw-body and webhook-signature
 * behaviour. The plugin has a genuine runtime-specific code path (Bun.serve
 * on Bun, the node:http shim otherwise, which rebuilds the Web Request via
 * Readable.toWeb), so byte fidelity of the raw body and signature accept /
 * reject decisions must be proven identical on both. The adapter-cross-runtime
 * CI jobs run this file once per runtime; the suite itself is runtime-agnostic
 * and simply exercises whichever server path the current runtime selects.
 */

const WEBHOOK_SECRET = "whsec_cross_runtime";

function signSha256Hex(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

async function bootHttp(
  routes: Parameters<ReturnType<typeof testContext>["routes"]>[0],
): Promise<{
  ctx: TestContext;
  port: number;
}> {
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

describe("http source rawBody + signature (cross-runtime contract)", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  /**
   * @case rawBody bytes survive the runtime's request bridging byte-for-byte
   * @preconditions Route with http({ rawBody: true }); JSON body with unicode, odd whitespace, and non-sorted keys
   * @expectedResult routecraft.http.rawBody equals the wire bytes exactly on this runtime's server path
   */
  test("rawBody is byte-faithful through this runtime's server path", async () => {
    let captured: Uint8Array | undefined;
    const wireBody = '{ "z":\t"snowman ☃ / emoji 🚀",  "a": [1,2 ,3] }';
    const bound = await bootHttp(
      craft()
        .id("xr-raw")
        .from(http({ path: "/xr-raw", method: "POST", rawBody: true }))
        .process(async (ex) => {
          captured = ex.headers["routecraft.http.rawBody"];
          return DefaultExchange.rewrap(ex, { body: { ok: true } });
        })
        .to(noop()),
    );
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/xr-raw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: wireBody,
    });
    expect(res.status).toBe(200);
    expect(captured).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(captured!).equals(Buffer.from(wireBody))).toBe(true);
  });

  /**
   * @case Signature verification decides identically on this runtime's server path
   * @preconditions Route with a GitHub-style hmac-sha256-hex signature gate
   * @expectedResult Correctly signed request returns 200; tampered body returns 401 with the bounded reason
   */
  test("signature accepts valid and rejects tampered deliveries", async () => {
    const body = '{"action":"opened"}';
    const bound = await bootHttp(
      craft()
        .id("xr-sig")
        .from(
          http({
            path: "/xr-sig",
            method: "POST",
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
              prefix: "sha256=",
            },
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
    );
    t = bound.ctx;

    const url = `http://127.0.0.1:${bound.port}/xr-sig`;
    const good = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signSha256Hex(body)}`,
      },
      body,
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ received: true });

    const bad = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signSha256Hex(body)}`,
      },
      body: '{"action":"tampered"}',
    });
    expect(bad.status).toBe(401);
    expect((await bad.json()) as Record<string, unknown>).toEqual({
      error: "unauthorized",
      reason: "invalid signature",
    });
  });
});
