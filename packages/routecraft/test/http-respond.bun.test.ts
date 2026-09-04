import { describe, test, expect, afterEach } from "bun:test";
import {
  bootServer,
  signHs256,
  testContext,
  type TestContext,
} from "@routecraft/testing";
import {
  craft,
  http,
  jwt,
  noop,
  type CraftConfig,
  type EventName,
  type HttpPluginOptions,
  type HttpResponder,
  type ValidatorAuthOptions,
} from "@routecraft/routecraft";
import { createHmac } from "node:crypto";

const WEBHOOK_SECRET = "whsec_test_please_change_me";
const JWT_SECRET = "test-secret-please-change-me";
const JWT_ISSUER = "https://idp.test";
const JWT_AUDIENCE = "https://api.test";

/**
 * A promise plus its resolver. Every timing claim in this file is proved by
 * ordering against one of these rather than by a sleep: the pipeline parks on
 * the gate, the assertion runs, and only then is the gate opened. A test that
 * waited a few milliseconds instead would pass on a fast machine whether or
 * not the response actually preceded the pipeline.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Yield for `ms`, portable across runtimes (the suite runs on Node too). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The webhook form from the docs: answer 202 at once, never touch `finished`,
 * leave the pipeline running detached.
 */
const ACKNOWLEDGE: HttpResponder = () => ({ status: 202 });

/**
 * A responder that awaits the pipeline, which is what the framework does on
 * its own. Used to show the two halves of the same option side by side.
 */
const AWAIT_RESULT: HttpResponder = async ({ finished }) => ({
  status: 200,
  body: (await finished).body,
});

function signSha256Hex(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

interface BootHttpOptions {
  routes: Parameters<ReturnType<typeof testContext>["routes"]>[0];
  http: HttpPluginOptions;
  /** Server-level validator (servers.default.auth), inherited by mounts. */
  serverAuth?: ValidatorAuthOptions;
  events?: Partial<Record<EventName, (ev: { details: unknown }) => void>>;
}

/**
 * Thin wrapper over the shared `bootServer` helper: this suite always wants
 * the same config shape, so only the routes, the optional wall and the
 * optional event subscriptions vary.
 */
async function bootHttp(
  opts: BootHttpOptions,
): Promise<{ ctx: TestContext; port: number }> {
  return bootServer((builder) => {
    let b = builder.routes(opts.routes).with({
      servers: {
        default: {
          port: 0,
          ...(opts.serverAuth !== undefined ? { auth: opts.serverAuth } : {}),
        },
      },
      http: opts.http,
    } as CraftConfig);
    for (const [name, handler] of Object.entries(opts.events ?? {})) {
      b = b.on(
        name as EventName,
        handler as Parameters<ReturnType<typeof testContext>["on"]>[1],
      );
    }
    return b;
  });
}

describe("HTTP source respond", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  /**
   * @case The 202 arrives before the pipeline finishes
   * @preconditions a responder answering 202 without awaiting `finished`, on a route whose step parks on a deferred the test resolves only after asserting the response
   * @expectedResult The fetch resolves 202 with an empty body while the step is still parked; the step then completes
   */
  test("answers 202 before a slow pipeline step completes", async () => {
    const gate = deferred();
    let stepEntered = false;
    let stepFinished = false;
    const bound = await bootHttp({
      routes: craft()
        .id("accepted-slow")
        .from(
          http({ path: "/hooks/slow", method: "POST", respond: ACKNOWLEDGE }),
        )
        .process(async (ex) => {
          stepEntered = true;
          await gate.promise;
          stepFinished = true;
          return ex;
        })
        .to(noop()),
      http: {},
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/slow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1" }),
    });

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    // The load-bearing assertion: the response is already in hand while the
    // pipeline is still parked, so the answer cannot have waited on it.
    expect(stepEntered).toBe(true);
    expect(stepFinished).toBe(false);

    gate.resolve();
    await sleep(0);
    expect(stepFinished).toBe(true);
  });

  /**
   * @case The default is unchanged
   * @preconditions The same route shape with respond omitted
   * @expectedResult 200 carrying the pipeline's body, exactly as before the option existed
   */
  test("respond omitted still answers with the pipeline result", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("default-result")
        .from(http({ path: "/hooks/default", method: "POST" }))
        .transform(() => ({ received: true }))
        .to(noop()),
      http: {},
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/default`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  /**
   * @case A responder that awaits the pipeline answers with its result
   * @preconditions A responder awaiting `finished` and returning the finished exchange's body
   * @expectedResult 200 with the pipeline's body, so the same option covers both waiting and not waiting
   */
  test("a responder that awaits finished answers with the result", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("explicit-result")
        .from(
          http({
            path: "/hooks/explicit",
            method: "POST",
            respond: AWAIT_RESULT,
          }),
        )
        .transform(() => ({ received: true }))
        .to(noop()),
      http: {},
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/explicit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  /**
   * @case A bad signature still rejects, and the early answer never happens
   * @preconditions a responder answering 202 without awaiting `finished`, alongside a signature gate, with a signature computed over a different body
   * @expectedResult 401 { error: "unauthorized", reason: "invalid signature" }; the pipeline never runs
   */
  test("a signature failure answers 401 and never runs the pipeline", async () => {
    let routeRan = false;
    const bound = await bootHttp({
      routes: craft()
        .id("accepted-signed")
        .from(
          http({
            path: "/hooks/signed",
            method: "POST",
            respond: ACKNOWLEDGE,
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
            },
          }),
        )
        .process((ex) => {
          routeRan = true;
          return ex;
        })
        .to(noop()),
      http: {},
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/signed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signSha256Hex('{"tampered":true}'),
      },
      body: JSON.stringify({ id: "evt_1" }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthorized",
      reason: "invalid signature",
    });
    await sleep(5);
    expect(routeRan).toBe(false);
  });

  /**
   * @case A correctly signed delivery is accepted early
   * @preconditions a responder answering 202 without awaiting `finished`, with a signature gate and a valid signature over the exact body sent
   * @expectedResult 202 with an empty body, and the pipeline runs
   */
  test("a valid signature is answered 202 and the pipeline runs", async () => {
    const body = JSON.stringify({ id: "evt_1" });
    const ran = deferred();
    let routeRan = false;
    const bound = await bootHttp({
      routes: craft()
        .id("accepted-signed-ok")
        .from(
          http({
            path: "/hooks/signed-ok",
            method: "POST",
            respond: ACKNOWLEDGE,
            signature: {
              header: "x-hub-signature-256",
              secret: WEBHOOK_SECRET,
              scheme: "hmac-sha256-hex",
            },
          }),
        )
        .process((ex) => {
          routeRan = true;
          ran.resolve();
          return ex;
        })
        .to(noop()),
      http: {},
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/signed-ok`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signSha256Hex(body),
      },
      body,
    });

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    await ran.promise;
    expect(routeRan).toBe(true);
  });

  /**
   * @case The mount's wall still rejects before the early answer
   * @preconditions a responder answering 202 without awaiting `finished`, on a walled mount, request carrying no credential
   * @expectedResult 401 and the pipeline never runs, so the option cannot be used to skip admission
   */
  test("a walled mount answers 401 and never runs the pipeline", async () => {
    let routeRan = false;
    const bound = await bootHttp({
      routes: craft()
        .id("accepted-walled")
        .from(
          http({ path: "/hooks/walled", method: "POST", respond: ACKNOWLEDGE }),
        )
        .process((ex) => {
          routeRan = true;
          return ex;
        })
        .to(noop()),
      http: {},
      serverAuth: jwt({
        secret: JWT_SECRET,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      }),
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/walled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1" }),
    });

    expect(res.status).toBe(401);
    await sleep(5);
    expect(routeRan).toBe(false);

    // And the same route admits a valid credential, so the 401 above is the
    // wall doing its job rather than the route being unreachable.
    const ok = await fetch(`http://127.0.0.1:${bound.port}/hooks/walled`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${signHs256({ secret: JWT_SECRET, claims: { sub: "user-1" } })}`,
      },
      body: JSON.stringify({ id: "evt_2" }),
    });
    expect(ok.status).toBe(202);
  });

  /**
   * @case A detached failure reaches the route's .error() handler
   * @preconditions a responder answering 202 without awaiting `finished`, on a route whose step throws after the 202 has been answered
   * @expectedResult The 202 is already sent, and the route's .error() handler still receives the failure
   */
  test("a pipeline failure after the 202 reaches .error()", async () => {
    const gate = deferred();
    const handled = deferred();
    let handledError: unknown;
    const bound = await bootHttp({
      routes: craft()
        .id("accepted-error")
        .from(
          http({ path: "/hooks/fails", method: "POST", respond: ACKNOWLEDGE }),
        )
        .error((error) => {
          handledError = error;
          handled.resolve();
          return { handled: true };
        })
        .process(async () => {
          await gate.promise;
          throw new Error("downstream exploded");
        })
        .to(noop()),
      http: {},
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/fails`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1" }),
    });
    expect(res.status).toBe(202);

    // The failure happens strictly after the response, which is the whole
    // point: there is no longer any response for it to be reported on.
    gate.resolve();
    await handled.promise;
    expect((handledError as Error).message).toContain("downstream exploded");
  });

  /**
   * @case A detached failure with no .error() handler still raises the error events
   * @preconditions a responder answering 202 without awaiting `finished`, no .error() handler, a step that throws after the 202
   * @expectedResult route:exchange:failed and route:error fire for the route, and the failure never surfaces as an unhandled rejection
   */
  test("a detached failure with no .error() handler raises route:exchange:failed", async () => {
    const gate = deferred();
    const failed = deferred();
    let failedRouteId: string | undefined;
    let routeErrorSeen = false;
    const bound = await bootHttp({
      routes: craft()
        .id("accepted-error-events")
        .from(
          http({
            path: "/hooks/fails-unhandled",
            method: "POST",
            respond: ACKNOWLEDGE,
          }),
        )
        .process(async () => {
          await gate.promise;
          throw new Error("downstream exploded");
        })
        .to(noop()),
      http: {},
      events: {
        ["route:exchange:failed" as EventName]: (ev: { details: unknown }) => {
          failedRouteId = (ev.details as { routeId: string }).routeId;
          failed.resolve();
        },
        ["route:error" as EventName]: () => {
          routeErrorSeen = true;
        },
      },
    });
    t = bound.ctx;

    const res = await fetch(
      `http://127.0.0.1:${bound.port}/hooks/fails-unhandled`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "evt_1" }),
      },
    );
    expect(res.status).toBe(202);

    gate.resolve();
    await failed.promise;
    expect(failedRouteId).toBe("accepted-error-events");
    expect(routeErrorSeen).toBe(true);
  });

  /**
   * @case request:completed reports the 202
   * @preconditions a responder answering 202 without awaiting `finished`, with per-request events on (the default)
   * @expectedResult One plugin:http:request:completed carrying status 202 for the route, emitted when the caller is answered rather than when the pipeline ends
   */
  test("plugin:http:request:completed reports status 202", async () => {
    const gate = deferred();
    const completed = deferred();
    let event: { status: number; routeId?: string } | undefined;
    const bound = await bootHttp({
      routes: craft()
        .id("accepted-events")
        .from(
          http({ path: "/hooks/events", method: "POST", respond: ACKNOWLEDGE }),
        )
        .process(async (ex) => {
          await gate.promise;
          return ex;
        })
        .to(noop()),
      http: {},
      events: {
        ["plugin:http:request:completed" as EventName]: (ev: {
          details: unknown;
        }) => {
          event = ev.details as { status: number; routeId?: string };
          completed.resolve();
        },
      },
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1" }),
    });
    expect(res.status).toBe(202);

    // Asserted while the pipeline is still parked, so the event cannot have
    // been emitted at the end of the run.
    await completed.promise;
    expect(event?.status).toBe(202);
    expect(event?.routeId).toBe("accepted-events");
    gate.resolve();
  });

  /**
   * @case A graceful shutdown waits for a detached run
   * @preconditions a responder answering 202 without awaiting `finished`, the pipeline parked on a deferred, stop() called immediately on receiving the 202 and never waiting for the pipeline to be observed first
   * @expectedResult stop() does not resolve while the detached run is parked, and the run completes rather than being abandoned. Stopping without first waiting for the step is deliberate: it also pins the ordering, because a dispatcher that answered before starting the run would enqueue after the drain had already found the route idle, and the delivery would be lost
   */
  test("shutdown waits for a detached run in flight", async () => {
    const gate = deferred();
    let stepEntered = false;
    let stepFinished = false;
    const bound = await bootHttp({
      routes: craft()
        .id("accepted-shutdown")
        .from(
          http({
            path: "/hooks/shutdown",
            method: "POST",
            respond: ACKNOWLEDGE,
          }),
        )
        .process(async (ex) => {
          stepEntered = true;
          await gate.promise;
          stepFinished = true;
          return ex;
        })
        .to(noop()),
      http: {},
    });

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1" }),
    });
    expect(res.status).toBe(202);

    let stopped = false;
    const stopping = bound.ctx.stop().then(() => {
      stopped = true;
    });

    // Give the shutdown a generous number of turns to reach its drain. It
    // must still be waiting, because the detached run is the route's
    // in-flight work.
    await sleep(50);
    expect(stepEntered).toBe(true);
    expect(stopped).toBe(false);
    expect(stepFinished).toBe(false);

    gate.resolve();
    await stopping;
    expect(stepFinished).toBe(true);
    // Already stopped; keep afterEach from stopping it twice.
    t = undefined;
  });

  /**
   * @case OpenAPI documents no success code for a route with a responder
   * @preconditions Two routes on the default mount, one with a responder and one without, with /openapi.json served
   * @expectedResult The responder route lists only the rejection codes, since nothing can know what a function returns; the route without one is unchanged
   */
  test("/openapi.json omits success codes for a route with a responder", async () => {
    const bound = await bootHttp({
      routes: [
        craft()
          .id("openapi-responder")
          .from(
            http({
              path: "/hooks/openapi",
              method: "POST",
              respond: ACKNOWLEDGE,
            }),
          )
          .to(noop()),
        craft()
          .id("openapi-default")
          .from(http({ path: "/orders", method: "POST" }))
          .to(noop()),
      ],
      http: {},
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };

    const responder = doc.paths["/hooks/openapi"]!["post"]!.responses;
    expect(Object.keys(responder)).not.toContain("200");
    expect(Object.keys(responder)).not.toContain("204");
    expect(Object.keys(responder)).not.toContain("202");
    // The gates still run ahead of the responder, so those answers stay
    // documented: a webhook route that could never be rejected would be the
    // opposite lie.
    expect(Object.keys(responder)).toContain("401");
    expect(Object.keys(responder)).toContain("413");

    const normal = doc.paths["/orders"]!["post"]!.responses;
    expect(Object.keys(normal)).toContain("200");
    expect(Object.keys(normal)).toContain("204");
  });

  /**
   * @case A batching route is refused rather than answering for a delivery it can drop
   * @preconditions .batch() before .from(), with a responder on the source
   * @expectedResult The context fails to start with RC5003 naming the combination. The refusal covers every responder, including one that would have awaited the pipeline, because nothing can tell before calling it. Without it the sender gets an answer for a message that sits in the batch buffer and is discarded at shutdown, having never run
   */
  test("a responder is refused on a batching route", async () => {
    const build = bootHttp({
      routes: craft()
        .id("accepted-batched")
        .batch({ size: 10 })
        .from(
          http({
            path: "/hooks/batched",
            method: "POST",
            respond: ACKNOWLEDGE,
          }),
        )
        .to(noop()),
      http: {},
    });
    await expect(build).rejects.toThrow(/RC5003|cannot be combined/);
  });

  /**
   * @case .batch() is unaffected on a route that answers with its result
   * @preconditions The same batching route with respond left at its default
   * @expectedResult The context starts, so the refusal is scoped to the acknowledging mode rather than banning batched http routes
   */
  test("a batching route still starts with no responder", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("default-batched")
        .batch({ size: 10 })
        .from(http({ path: "/hooks/batched-ok", method: "POST" }))
        .to(noop()),
      http: {},
    });
    t = bound.ctx;
    expect(bound.port).toBeGreaterThan(0);
  });

  /**
   * @case A delivery arriving after shutdown has begun is refused, not acknowledged
   * @preconditions a responder, with context.stop() already begun, a request whose body arrives in two chunks so it is still being read when the drain runs
   * @expectedResult 503 with retry-after rather than 202, and the pipeline never runs. Without the guard the sender is told 202 for a run the drain has already passed, and the delivery is lost with no redelivery coming
   */
  test("a request that arrives during shutdown answers 503, not 202", async () => {
    let stepRan = false;
    const bound = await bootHttp({
      routes: craft()
        .id("accepted-shutdown-window")
        .from(
          http({
            path: "/hooks/window",
            method: "POST",
            respond: ACKNOWLEDGE,
          }),
        )
        .process((ex) => {
          stepRan = true;
          return ex;
        })
        .to(noop()),
      http: {},
    });

    // A body delivered in two chunks: the dispatcher parks in its body read
    // between them, which is where the shutdown lands.
    let sendRest!: () => void;
    const gap = new Promise<void>((resolve) => {
      sendRest = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":'));
        await gap;
        controller.enqueue(new TextEncoder().encode('"evt_1"}'));
        controller.close();
      },
    });
    const inflight = fetch(`http://127.0.0.1:${bound.port}/hooks/window`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // @ts-expect-error duplex is required whenever the body is a stream
      duplex: "half",
    });

    await sleep(20);
    const stopping = bound.ctx.stop();
    await sleep(20);
    sendRest();

    const res = await inflight;
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toEqual({
      error: "service unavailable",
      reason: "shutting_down",
    });
    await stopping;
    expect(stepRan).toBe(false);
    t = undefined;
  });

  /**
   * @case A streaming body from an accepted route is cancelled rather than left open
   * @preconditions respond: ACKNOWLEDGE on a route whose pipeline ends with a ReadableStream carrying a cancel observer
   * @expectedResult The stream is cancelled once the detached run resolves. Without this the stream has no reader and holds whatever backs it until GC finalises it, if ever
   */
  test("a detached streaming body is cancelled", async () => {
    const cancelled = deferred();
    let cancelSeen = false;
    const bound = await bootHttp({
      routes: craft()
        .id("accepted-stream")
        .from(
          http({ path: "/hooks/stream", method: "POST", respond: ACKNOWLEDGE }),
        )
        .transform(
          () =>
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelSeen = true;
                cancelled.resolve();
              },
            }),
        )
        .to(noop()),
      http: {},
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1" }),
    });
    expect(res.status).toBe(202);

    await cancelled.promise;
    expect(cancelSeen).toBe(true);
  });

  /**
   * @case The descriptor's status, headers and body all reach the wire
   * @preconditions A responder returning a status, a custom header and an object body, without awaiting the pipeline
   * @expectedResult The response carries all three, serialised by the same rules a pipeline result would be, and the header name is lower-cased
   */
  test("a descriptor's status, headers and body are serialised", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("descriptor-full")
        .from(
          http({
            path: "/hooks/descriptor",
            method: "POST",
            respond: () => ({
              status: 207,
              headers: { "X-Delivery": "queued" },
              body: { queued: true },
            }),
          }),
        )
        .to(noop()),
      http: {},
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/descriptor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1" }),
    });
    expect(res.status).toBe(207);
    expect(res.headers.get("x-delivery")).toBe("queued");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ queued: true });
  });

  /**
   * @case The responder sees the request as the route sees it
   * @preconditions A responder reading the parsed body, the path params, the method and a request header, on a route with a :id segment
   * @expectedResult All four are present and already parsed, so the responder never needs the Request, whose body has been consumed by the parser and the signature gate
   */
  test("the responder receives the parsed request, not the Request", async () => {
    const bound = await bootHttp({
      routes: craft()
        .id("descriptor-request")
        .from(
          http({
            path: "/hooks/:id/echo",
            method: "POST",
            respond: ({ request }) => ({
              status: 200,
              body: {
                body: request.body,
                id: request.params["id"],
                method: request.method,
                path: request.path,
                header: request.headers["x-source"],
              },
            }),
          }),
        )
        .to(noop()),
      http: {},
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/hooks/evt_9/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-source": "bird" },
      body: JSON.stringify({ kind: "message" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      body: { kind: "message" },
      id: "evt_9",
      method: "POST",
      path: "/hooks/:id/echo",
      header: "bird",
    });
  });

  /**
   * @case A respond that is not callable is refused at the call site
   * @preconditions http({ respond }) built with a string, as an untyped caller or a stale example would produce
   * @expectedResult RC5003 thrown from http({...}) itself rather than a 500 on the first delivery
   */
  test("a non-callable respond throws RC5003 at construction", () => {
    expect(() =>
      http({
        path: "/hooks/bad",
        method: "POST",
        respond: "accepted" as unknown as HttpResponder,
      }),
    ).toThrow(/RC5003|respond must be a function/);
  });
});
