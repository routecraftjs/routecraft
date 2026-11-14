import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  definePlugin,
  direct,
  noop,
  simple,
  type EventPayload,
  type ExchangeSnapshot,
} from "@routecraft/routecraft";
import { PluginHost } from "../src/kernel/host.ts";
import { BRAND, setBrand } from "../src/brand.ts";
import { snapshotOf } from "../src/event-snapshot.ts";
import { DEFAULT_REDACT } from "../src/logger.ts";
import { httpPlugin } from "../src/plugins/http/plugin.ts";
import { CREDENTIAL_HEADERS } from "../src/shared/credential-headers.ts";
import { safeStringify } from "../src/shared/safe-json.ts";
import { asDeferred, deferring } from "./helpers/deferral.ts";

const SECRET_HEADERS = {
  Authorization: "Bearer s3cret",
  cookie: "sid=s3cret",
  "SET-COOKIE": "sid=s3cret",
  "Proxy-Authorization": "Basic s3cret",
  "X-Warehouse-Key": "s3cret",
  "x-request-id": "r-1",
};

describe("event body policy", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  /**
   * @case A plain subscriber is handed no exchange and no snapshot
   * @preconditions A direct route whose caller sends credential headers; subscribers without options on the four lifecycle events and on "*"
   * @expectedResult Every payload carries exchangeId and neither `exchange` nor `_snapshot`, and no payload serializes the credential
   */
  test("a plain subscriber never sees a body or a header", async () => {
    const seen: EventPayload<"route:exchange:completed">[] = [];
    const all: unknown[] = [];
    t = await testContext()
      .on("route:exchange:completed", (payload) => {
        seen.push(payload);
      })
      .routes(craft().id("plain").from(direct()).to(noop()))
      .build();
    t.ctx.on("*", (payload) => {
      all.push(payload.details);
    });
    await t.startAndWaitReady();
    await t.client.sendDirect("plain", { card: "4111" }, SECRET_HEADERS);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.details.exchangeId).toBeString();
    expect(seen[0]!.details).not.toHaveProperty("_snapshot");
    expect(seen[0]!.details).not.toHaveProperty("exchange");
    const text = safeStringify(all);
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("4111");
  });

  /**
   * @case An opted-in subscriber receives a frozen copy without credentials
   * @preconditions The same send, a plugin declaring secretHeaders: ["x-warehouse-key"], and a subscriber made with { snapshots: true }
   * @expectedResult `_snapshot.exchange` holds the body and the ordinary header; Authorization, Cookie, Set-Cookie, Proxy-Authorization and the declared header are absent whatever their case; the copy is frozen at every depth and is not the live body
   */
  test("an opted-in subscriber sees a frozen copy with credentials removed", async () => {
    const snapshots: ExchangeSnapshot[] = [];
    const body = { order: { id: "o-1" } };
    t = await testContext()
      .with({
        plugins: [
          definePlugin({
            id: "acme.warehouse",
            secretHeaders: ["x-warehouse-key"],
          }),
        ],
      })
      .on(
        "route:exchange:completed",
        ({ details }) => {
          if (details._snapshot) snapshots.push(details._snapshot.exchange);
        },
        { snapshots: true },
      )
      .routes(craft().id("opted").from(direct()).to(noop()))
      .build();
    await t.startAndWaitReady();
    await t.client.sendDirect("opted", body, SECRET_HEADERS);

    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(snapshot.body).toEqual(body);
    expect(snapshot.body).not.toBe(body);
    expect(snapshot.headers["x-request-id"]).toBe("r-1");
    expect(JSON.stringify(snapshot)).not.toContain("s3cret");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.headers)).toBe(true);
    expect(Object.isFrozen((snapshot.body as { order: object }).order)).toBe(
      true,
    );
  });

  /**
   * @case A value that cannot be cloned does not fail the event
   * @preconditions A route whose body holds a function, completed with an opted-in subscriber
   * @expectedResult The subscriber is called, and the body in the snapshot is { unserializable: true }
   */
  test("an uncloneable body is replaced, not thrown", async () => {
    const bodies: unknown[] = [];
    t = await testContext()
      .on(
        "route:exchange:completed",
        ({ details }) => {
          bodies.push(details._snapshot?.exchange.body);
        },
        { snapshots: true },
      )
      .routes(
        craft()
          .id("closure")
          .from(simple({ run: () => 1 }))
          .to(noop()),
      )
      .build();
    await t.test();

    expect(bodies).toEqual([{ unserializable: true }]);
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case Lifecycle events say who the exchange ran as, by reference
   * @preconditions A route that authenticates as alice with a claim; plain subscribers on completed
   * @expectedResult `principal` is { subject: "alice" } alone: the claims of the live principal are not on the event
   */
  test("lifecycle events carry a principal reference, not the principal", async () => {
    const principals: unknown[] = [];
    t = await testContext()
      .on("route:exchange:completed", ({ details }) => {
        principals.push(details.principal);
      })
      .routes(
        craft()
          .id("who")
          .from(simple("x"))
          .authenticate(() => ({
            subject: "alice",
            claims: { email: "alice@example.test" },
          }))
          .to(noop()),
      )
      .build();
    await t.test();

    expect(principals).toEqual([{ subject: "alice" }]);
  });

  /**
   * @case The error events name the exchange by id
   * @preconditions A route whose step throws; plain subscribers on route:error and context:error
   * @expectedResult Both carry the failing exchange's id and no exchange object
   */
  test("error events carry exchangeId", async () => {
    const ids: unknown[] = [];
    let failed: string | undefined;
    t = await testContext()
      .on("route:exchange:failed", ({ details }) => {
        failed = details.exchangeId;
      })
      .on("route:error", ({ details }) => {
        ids.push(details.exchangeId);
        expect(details).not.toHaveProperty("exchange");
      })
      .on("context:error", ({ details }) => {
        ids.push(details.exchangeId);
      })
      .routes(
        craft()
          .id("boom")
          .from(simple("x"))
          .process(() => {
            throw new Error("boom");
          })
          .to(noop()),
      )
      .build();
    await t.test();

    expect(failed).toBeString();
    expect(ids).toEqual([failed, failed]);
  });

  /**
   * @case The config keys take a handler with its options
   * @preconditions `on` holding { handler, snapshots: true } for completed, beside a bare handler
   * @expectedResult The object form receives the snapshot and the bare one does not
   */
  test("on in config accepts { handler, snapshots }", async () => {
    const got: boolean[] = [];
    t = await testContext()
      .with({
        on: {
          "route:exchange:completed": [
            {
              handler: ({ details }) => {
                got.push("_snapshot" in (details as object));
              },
              snapshots: true,
            },
            ({ details }) => {
              got.push("_snapshot" in (details as object));
            },
          ],
        },
      })
      .routes(craft().id("cfg").from(simple("x")).to(noop()))
      .build();
    await t.test();

    expect(got).toEqual([true, false]);
  });

  /**
   * @case The opt-in belongs to the subscription, not to the handler
   * @preconditions One handler subscribed to completed with { snapshots: true } and to started without; a second handler subscribed with snapshots, unsubscribed, and subscribed again without
   * @expectedResult The first handler gets the envelope on completed only, and the second gets none
   */
  test("one handler's opt-in does not reach its other subscriptions", async () => {
    const shared: Record<string, boolean> = {};
    const resubscribed: boolean[] = [];
    const handler = (payload: EventPayload<never>): void => {
      shared[payload._event ?? ""] = "_snapshot" in (payload.details as object);
    };
    const again = (payload: EventPayload<never>): void => {
      resubscribed.push("_snapshot" in (payload.details as object));
    };
    t = await testContext()
      .on("route:exchange:completed", handler as never, { snapshots: true })
      .on("route:exchange:failed", handler as never)
      .routes(
        craft()
          .id("scoped")
          .from(direct())
          .process((ex) => {
            if (ex.body === "bad") throw new Error("refused");
            return ex;
          })
          .to(noop()),
      )
      .build();
    const off = t.ctx.on("route:exchange:completed", again as never, {
      snapshots: true,
    });
    off();
    t.ctx.on("route:exchange:completed", again as never);
    await t.startAndWaitReady();
    await t.client.sendDirect("scoped", "good");
    await t.client.sendDirect("scoped", "bad").catch(() => undefined);

    expect(shared).toEqual({
      "route:exchange:completed": true,
      "route:exchange:failed": false,
    });
    expect(resubscribed).toEqual([false]);
  });

  /**
   * @case A snapshot is copied only when a handler reads it, and never on started
   * @preconditions A body whose getter counts its reads; opted-in subscribers on started and completed that do not read the exchange, then one on completed that does
   * @expectedResult started carries no envelope; the getter is not read until the reading subscriber runs, and then once however many subscribers read it
   */
  test("the copy is made on first read, once", async () => {
    let reads = 0;
    const body = {
      get total() {
        reads += 1;
        return 42;
      },
    };
    const started: boolean[] = [];
    const copies: unknown[] = [];
    let read = false;
    const reader = ({
      details,
    }: EventPayload<"route:exchange:completed">): void => {
      if (read) copies.push(details._snapshot?.exchange.body);
    };
    t = await testContext()
      .on(
        "route:exchange:started",
        ({ details }) => {
          started.push("_snapshot" in details);
        },
        { snapshots: true },
      )
      .on("route:exchange:completed", reader, { snapshots: true })
      .on("route:exchange:completed", (payload) => reader(payload), {
        snapshots: true,
      })
      .routes(craft().id("lazy").from(direct()).to(noop()))
      .build();
    await t.startAndWaitReady();
    await t.client.sendDirect("lazy", body);
    const before = reads;
    read = true;
    await t.client.sendDirect("lazy", body);

    expect(started).toEqual([false, false]);
    expect(copies).toEqual([{ total: 42 }, { total: 42 }]);
    expect(copies[0]).toBe(copies[1]);
    expect(before).toBe(0);
    expect(reads).toBe(1);
  });

  /**
   * @case An asynchronous opted-in handler holds the exchange as it was at the event
   * @preconditions An async subscriber that reads the snapshot after an await, and a caller that changes the body once the send settles
   * @expectedResult The snapshot holds the body the exchange ended with
   */
  test("an async handler reads the body of the event, not a later one", async () => {
    const body = { state: "ended" };
    let late: unknown;
    let done: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => (done = resolve));
    t = await testContext()
      .on(
        "route:exchange:completed",
        async ({ details }) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          late = details._snapshot?.exchange.body;
          done?.();
        },
        { snapshots: true },
      )
      .routes(craft().id("late").from(direct()).to(noop()))
      .build();
    await t.startAndWaitReady();
    await t.client.sendDirect("late", body);
    body.state = "changed";
    await settled;

    expect(late).toEqual({ state: "ended" });
  });

  /**
   * @case A credential inside a door's own header is left out too
   * @preconditions An exchange shaped as the HTTP door builds it: the wire headers as a map under routecraft.http.rawHeaders, the parsed cookies under routecraft.http.cookies, a principal with claims, a Secret in the body and a header that contains itself
   * @expectedResult The copy keeps the ordinary wire header and drops Authorization and Cookie inside the map and the cookie header the HTTP plugin declares; the principal is its reference; the Secret is withheld; the cyclic header is copied
   */
  test("nested wire headers, cookies, the principal and a Secret are withheld", () => {
    const declared = httpPlugin({} as never).secretHeaders ?? [];
    const secret = new Set(
      [...CREDENTIAL_HEADERS, ...declared].map((name) => name.toLowerCase()),
    );
    const apiKey = { value: "s3cret" };
    setBrand(apiKey, BRAND.Secret);
    const loop: Record<string, unknown> = { name: "loop" };
    loop["self"] = loop;

    const snapshot = snapshotOf(
      {
        id: "x-1",
        headers: {
          "routecraft.http.rawHeaders": Object.freeze({
            Authorization: "Bearer s3cret",
            cookie: "sid=s3cret",
            accept: "application/json",
          }),
          "routecraft.http.cookies": { sid: "s3cret" },
          "routecraft.auth.principal": {
            kind: "user",
            subject: "u-1",
            issuer: "https://issuer.test",
            claims: { email: "s3cret@example.test" },
            scopes: ["orders:read"],
          },
          "acme.loop": loop,
        },
        body: { order: "o-1", apiKey, lines: [{ apiKey }] },
      },
      secret,
    );

    expect(JSON.stringify(snapshot.body)).not.toContain("s3cret");
    expect(snapshot.body).toEqual({
      order: "o-1",
      apiKey: { secret: true },
      lines: [{ apiKey: { secret: true } }],
    });
    expect(snapshot.headers["routecraft.http.rawHeaders"]).toEqual({
      accept: "application/json",
    });
    expect(snapshot.headers).not.toHaveProperty("routecraft.http.cookies");
    expect(snapshot.headers["routecraft.auth.principal"]).toEqual({
      subject: "u-1",
      issuer: "https://issuer.test",
    });
    const copied = snapshot.headers["acme.loop"] as Record<string, unknown>;
    expect(copied["self"]).toBe(copied);
  });

  /**
   * @case A credential or a Secret inside a Map, a Set or a class instance is left out too
   * @preconditions A wire-header Map holding Authorization under one header; a body holding a Secret inside a Map, a Set and a class instance
   * @expectedResult The Map keeps its ordinary entry alone, and every Secret is withheld wherever it sits
   */
  test("secrets inside Maps, Sets and class instances are withheld", () => {
    const apiKey = { value: "s3cret" };
    setBrand(apiKey, BRAND.Secret);
    class Order {
      constructor(readonly key: unknown) {}
    }

    const snapshot = snapshotOf(
      {
        id: "x-1",
        headers: {
          "acme.wire": new Map<string, unknown>([
            ["Authorization", "Bearer s3cret"],
            ["accept", "application/json"],
          ]),
        },
        body: {
          byName: new Map([["key", apiKey]]),
          all: new Set([apiKey]),
          order: new Order(apiKey),
        },
      },
      new Set(CREDENTIAL_HEADERS),
    );

    expect(snapshot.headers["acme.wire"]).toEqual(
      new Map([["accept", "application/json"]]),
    );
    expect(snapshot.body).toEqual({
      byName: new Map([["key", { secret: true }]]),
      all: new Set([{ secret: true }]),
      order: { key: { secret: true } },
    });
  });

  /**
   * @case A snapshot shares no memory with the live exchange
   * @preconditions A body holding a typed array over a SharedArrayBuffer, which a structured clone would share rather than copy
   * @expectedResult The view is replaced with { unserializable: true } and the rest of the body is copied
   */
  test("memory shared with the exchange is not handed out", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(1));

    const snapshot = snapshotOf(
      { id: "x-1", headers: {}, body: { order: "o-1", bytes: shared } },
      new Set(),
    );

    expect(snapshot.body).toEqual({
      order: "o-1",
      bytes: { unserializable: true },
    });
  });

  /**
   * @case A parked exchange is attributable, and its acknowledgment is not copied
   * @preconditions A route that authenticates as alice and defers; a subscription with snapshots on route:exchange:deferred
   * @expectedResult The event carries principal { subject: "alice" } and no `_snapshot`, so the resume token in the acknowledgment reaches no subscriber
   */
  test("deferred carries the principal reference and no snapshot", async () => {
    const seen: EventPayload<"route:exchange:deferred">["details"][] = [];
    t = await testContext()
      .with(deferring())
      .on(
        "route:exchange:deferred",
        ({ details }) => {
          seen.push(details);
        },
        { snapshots: true },
      )
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .authenticate(() => ({ subject: "alice" }))
          .defer({ input: z.object({ approved: z.boolean() }) })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("payout", { n: 1 }));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.principal).toEqual({ subject: "alice" });
    expect(seen[0]).not.toHaveProperty("_snapshot");
    expect(JSON.stringify(seen[0])).not.toContain(deferred.token);
  });

  /**
   * @case Log lines and snapshots withhold the same credential headers
   * @preconditions The shared list of credential header names
   * @expectedResult The logger's default redaction has one path per name, in its published spelling
   */
  test("the logger redacts every credential header a snapshot leaves out", () => {
    expect(DEFAULT_REDACT).toEqual([
      "headers.authorization",
      "headers.cookie",
      'headers["set-cookie"]',
      'headers["proxy-authorization"]',
    ]);
    expect(DEFAULT_REDACT).toHaveLength(CREDENTIAL_HEADERS.length);
  });

  /**
   * @case An error event names its exchange's journey
   * @preconditions A route that throws, and a plain subscriber on route:error, route:step:error and context:error
   * @expectedResult Each carries the exchange's id and its correlation id
   */
  test("error events carry the correlation id of their exchange", async () => {
    const seen: Record<string, unknown> = {};
    let correlationId: unknown;
    const note = (payload: EventPayload<never>): void => {
      const details = payload.details as {
        exchangeId?: string;
        correlationId?: string;
      };
      if (details.exchangeId !== undefined) {
        seen[payload._event ?? ""] = details.correlationId;
      }
    };
    t = await testContext()
      .on("route:error", note as never)
      .on("route:step:error", note as never)
      .on("context:error", note as never)
      .on("route:exchange:failed", ({ details }) => {
        correlationId = details.correlationId;
      })
      .routes(
        craft()
          .id("broken")
          .from(direct())
          .process(() => {
            throw new Error("refused");
          })
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    await t.client.sendDirect("broken", "x").catch(() => undefined);

    expect(correlationId).toBeString();
    expect(seen).toEqual({
      "route:error": correlationId,
      "route:step:error": correlationId,
      "context:error": correlationId,
    });
  });

  /**
   * @case The application says at start who reads snapshots
   * @preconditions Two plugins observing completed, one with { snapshots: true }, and an application subscriber made with it on the builder
   * @expectedResult One info line names the opted-in plugin's id and the application, and not the other plugin
   */
  test("start logs who subscribed with snapshots", async () => {
    t = await testContext()
      .on("route:exchange:failed", () => {}, { snapshots: true })
      .with({
        plugins: [
          definePlugin({
            id: "acme.reader",
            bind(c) {
              c.observe("route:exchange:completed", () => {}, {
                snapshots: true,
              });
            },
          }),
          definePlugin({
            id: "acme.counter",
            bind(c) {
              c.observe("route:exchange:completed", () => {});
            },
          }),
        ],
      })
      .routes(craft().id("log").from(simple("x")).to(noop()))
      .build();
    await t.test();

    const line = t.contextLogger.info.mock.calls.find(
      (call) => call[1] === "Subscribed to event snapshots",
    );
    expect([...(line?.[0] as { readers: string[] }).readers].sort()).toEqual([
      "acme.reader",
      "application",
    ]);
  });

  /**
   * @case secretHeaders is checked with the rest of the descriptor
   * @preconditions Descriptors whose secretHeaders is a string, and an array holding an empty name
   * @expectedResult RC1117 for each
   */
  test("a malformed secretHeaders is RC1117", () => {
    for (const secretHeaders of ["authorization", [""]]) {
      expect(() => new PluginHost([{ id: "x.a", secretHeaders }])).toThrow(
        expect.objectContaining({ rc: "RC1117" }),
      );
    }
  });
});
