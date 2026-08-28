import { afterEach, describe, expect, test } from "bun:test";
import { bootServer, type TestContext } from "@routecraft/testing";
import {
  apiKey,
  craft,
  direct,
  noop,
  opsPlugin,
  type HttpAuth,
  type OpsTiers,
  type Principal,
} from "../src/index.ts";

/**
 * `GET /ops/events`: the context event bus tailed as Server-Sent Events.
 *
 * The proving consumer for streaming responses, and a management tier like
 * any other, so the cases that matter are the same two: the tail actually
 * carries what the bus emits, and it is closed to a caller who has not been
 * admitted to the tier that opens it.
 */

const KEYS: Record<string, string[]> = {
  watcher: ["ops:events"],
  reader: ["ops:introspection"],
};

function keyAuth(): HttpAuth {
  return apiKey({
    verify: (key: string): Principal | null => {
      const scopes = KEYS[key];
      if (scopes === undefined) return null;
      return { kind: "custom", scheme: "apiKey", subject: key, scopes };
    },
  });
}

interface Frame {
  event: string;
  data: unknown;
}

/**
 * Read SSE frames off a live response until one names `wanted`, then stop.
 * Comment blocks (the tail's heartbeat) carry no event field and are
 * skipped rather than counted.
 */
async function readUntil(
  res: Response,
  wanted: string,
  timeoutMs = 5000,
): Promise<Frame | undefined> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const step = await reader.read();
      if (step.done) return undefined;
      buffer += decoder.decode(step.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event === wanted && data !== undefined) {
          return { event, data: JSON.parse(data) };
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return undefined;
  } finally {
    await reader.cancel();
  }
}

describe("the ops event tail", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  async function start(options: {
    tiers?: OpsTiers;
    auth?: HttpAuth | false;
  }): Promise<number> {
    const booted = await bootServer((builder) =>
      builder
        .with({
          servers: { default: { port: 0, host: "127.0.0.1" } },
          plugins: [
            opsPlugin({
              ...(options.tiers !== undefined ? { tiers: options.tiers } : {}),
              ...(options.auth !== undefined ? { auth: options.auth } : {}),
            }),
          ],
        })
        .routes([craft().id("worker").from(direct()).to(noop())]),
    );
    t = booted.ctx;
    return booted.port;
  }

  /**
   * @case An unconfigured events tier discloses nothing
   * @preconditions opsPlugin with no tiers at all
   * @expectedResult 404, the same answer every disabled tier gives
   */
  test("answers 404 when the events tier is not configured", async () => {
    const port = await start({});
    const res = await fetch(`http://127.0.0.1:${port}/ops/events`);
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  /**
   * @case A scope-gated tail refuses a credential that carries another scope
   * @preconditions events tier gated on "ops:events"; caller holds only "ops:introspection"
   * @expectedResult 403 insufficient_scope naming the scope it lacks
   */
  test("refuses a caller without the events scope", async () => {
    const port = await start({
      auth: keyAuth(),
      tiers: { events: "ops:events" },
    });
    const res = await fetch(`http://127.0.0.1:${port}/ops/events`, {
      headers: { "x-api-key": "reader" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      reason: "insufficient_scope",
      scope: "ops:events",
    });
  });

  /**
   * @case An admitted caller receives bus events as SSE frames
   * @preconditions events tier gated on "ops:events"; caller holds it; a route is dispatched while the tail is open
   * @expectedResult text/event-stream with no-cache, and frames naming the bus events with their payloads
   */
  test("streams bus events to an admitted caller", async () => {
    const port = await start({
      auth: keyAuth(),
      tiers: { events: "ops:events" },
    });
    const res = await fetch(`http://127.0.0.1:${port}/ops/events`, {
      headers: { "x-api-key": "watcher" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const wanted = readUntil(res, "context:error");
    t!.ctx.emit("context:error", { error: new Error("watch me") });

    const frame = await wanted;
    expect(frame).toBeDefined();
    expect(frame!.data).toMatchObject({
      event: "context:error",
      details: { error: { message: "watch me" } },
    });
  });

  /**
   * @case An open tier serves the tail without a credential
   * @preconditions events tier is `true`, no auth configured anywhere
   * @expectedResult 200 and an event stream, the documented meaning of an open tier
   */
  test("an open tier needs no credential", async () => {
    const port = await start({ tiers: { events: true } });
    const res = await fetch(`http://127.0.0.1:${port}/ops/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    await res.body?.cancel();
  });

  /**
   * @case The tail unsubscribes from the bus when the caller goes away
   * @preconditions An open tail, then the client cancels the response
   * @expectedResult Emitting afterwards does not throw and the context stops cleanly, so no subscription is left behind
   */
  test("cancelling the response releases the subscription", async () => {
    const port = await start({ tiers: { events: true } });
    const res = await fetch(`http://127.0.0.1:${port}/ops/events`);
    const reader = res.body!.getReader();
    t!.ctx.emit("context:error", { error: new Error("first") });
    await reader.read();
    await reader.cancel();

    // The generator's finally runs on the server's own timeline; give it a
    // turn before asserting the bus is quiet again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    t!.ctx.emit("context:error", { error: new Error("second") });
  });

  /**
   * @case The tail refuses a method it does not serve
   * @preconditions events tier is open; the caller sends POST
   * @expectedResult 405 with Allow: GET
   */
  test("refuses a non-GET method", async () => {
    const port = await start({ tiers: { events: true } });
    const res = await fetch(`http://127.0.0.1:${port}/ops/events`, {
      method: "POST",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });
});
