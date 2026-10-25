import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { signHs256, testContext, type TestContext } from "@routecraft/testing";
import {
  adoptTraceContext,
  craft,
  CraftContext,
  DefaultExchange,
  definePlugin,
  httpPlugin,
  remotesPlugin,
  TRACE_SPANS,
  direct,
  http,
  HeadersKeys,
  isTraceId,
  jwt,
  noop,
  opsPlugin,
  simple,
  traceContextOf,
  type CraftConfig,
  type Exchange,
  type Plugin,
  type TraceContextMode,
} from "../src/index.ts";
import { JOINED_HEADER, TRACE_PARENT_HEADER } from "../src/trace-context.ts";
import { listen } from "./helpers/listen.ts";

const SECRET = "trace-context-jwt-secret-please-change";
const ISSUER = "https://idp.test";
const AUDIENCE = "https://api.test";
const PARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

const bearer = (scope = "ops:dispatch"): string =>
  signHs256({ secret: SECRET, claims: { scope } });

/** The correlation and causation ids an exchange carries. */
function ids(exchange: Exchange): {
  id: string;
  correlationId: string;
  causationId: string | undefined;
  remoteParent: unknown;
} {
  return {
    id: exchange.id,
    correlationId: exchange.headers[HeadersKeys.CORRELATION_ID] as string,
    causationId: exchange.headers[HeadersKeys.CAUSATION_ID] as
      string | undefined,
    remoteParent: exchange.headers[TRACE_PARENT_HEADER],
  };
}

/**
 * A plugin whose `beforeAuth` observe hook records the journey ids, as a
 * ledger writing "capability requested" reads them: the earliest point a
 * plugin sees the exchange.
 */
function beforeAuthWitness(seen: ReturnType<typeof ids>[]): Plugin {
  return definePlugin({
    id: "test.ledger",
    hooks: {
      beforeAuth: {
        id: "requested",
        phase: "observe",
        run(exchange) {
          seen.push(ids(exchange));
        },
      },
    },
  });
}

describe("Trace context: the wire format", () => {
  /**
   * @case Adoption follows the mode and the caller's authentication
   * @preconditions A well-formed traceparent and an rc tracestate member, offered under each mode with and without a verified principal
   * @expectedResult authenticated adopts only an authenticated caller, always adopts both, never adopts neither, and a mode no caller validated falls back to authenticated; an adopted context marks the exchange as having joined its journey at a door
   */
  test("adopts under the mode", () => {
    const inbound = {
      traceparent: PARENT,
      tracestate: "other=x,rc=c:journey-1;x:exchange-9",
    };
    const adopted = (
      mode: TraceContextMode | undefined,
      authenticated: boolean,
    ) =>
      adoptTraceContext(inbound, {
        ...(mode !== undefined ? { mode } : {}),
        authenticated,
      });
    expect(adopted(undefined, false)).toEqual({});
    expect(adopted("authenticated", false)).toEqual({});
    expect(adopted("never", true)).toEqual({});
    expect(adopted("open" as TraceContextMode, false)).toEqual({});
    for (const result of [adopted(undefined, true), adopted("always", false)]) {
      expect(result).toEqual({
        [HeadersKeys.CORRELATION_ID]: "journey-1",
        [HeadersKeys.CAUSATION_ID]: "exchange-9",
        [TRACE_PARENT_HEADER]: PARENT,
        [JOINED_HEADER]: "door",
      });
    }
  });

  /**
   * @case A traceparent with no rc member yields the trace id as a UUID and no cause
   * @preconditions An OpenTelemetry-only caller: traceparent and a foreign tracestate
   * @expectedResult The correlation id is the trace id formatted 8-4-4-4-12; no causation id
   */
  test("falls back to the trace id without an rc member", () => {
    expect(
      adoptTraceContext(
        { traceparent: PARENT, tracestate: "vendor=abc" },
        { mode: "always", authenticated: false },
      ),
    ).toEqual({
      [HeadersKeys.CORRELATION_ID]: "4bf92f35-77b3-4da6-a3ce-929d0e0e4736",
      [TRACE_PARENT_HEADER]: PARENT,
      [JOINED_HEADER]: "door",
    });
  });

  /**
   * @case A malformed, version ff or all-zero traceparent is ignored with its whole context
   * @preconditions Each invalid form offered under "always" beside a valid rc member
   * @expectedResult Nothing is adopted for any of them
   */
  test("ignores an invalid traceparent", () => {
    for (const traceparent of [
      "garbage",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
      "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra",
    ]) {
      expect(
        adoptTraceContext(
          { traceparent, tracestate: "rc=c:journey-1;x:exchange-9" },
          { mode: "always", authenticated: true },
        ),
      ).toEqual({});
    }
  });

  /**
   * @case An rc field that is not a well-formed id is dropped
   * @preconditions A valid traceparent and an rc member whose correlation contains a space and whose cause is over 128 characters
   * @expectedResult The correlation falls back to the trace id and no cause is adopted
   */
  test("drops malformed rc fields", () => {
    const adopted = adoptTraceContext(
      {
        traceparent: PARENT,
        tracestate: `rc=c:not an id;x:${"a".repeat(129)}`,
      },
      { mode: "always", authenticated: true },
    );
    expect(adopted[HeadersKeys.CORRELATION_ID]).toBe(
      "4bf92f35-77b3-4da6-a3ce-929d0e0e4736",
    );
    expect(adopted[HeadersKeys.CAUSATION_ID]).toBeUndefined();
  });

  /**
   * @case isTraceId bounds the alphabet and the length
   * @preconditions Ids at and over the bound, and with characters outside the alphabet
   * @expectedResult A UUID and a 128-character id pass; 129 characters, an empty string, a space and a comma fail
   */
  test("isTraceId", () => {
    expect(isTraceId("4bf92f35-77b3-4da6-a3ce-929d0e0e4736")).toBe(true);
    expect(isTraceId("a".repeat(128))).toBe(true);
    expect(isTraceId("a".repeat(129))).toBe(false);
    expect(isTraceId("")).toBe(false);
    expect(isTraceId("a b")).toBe(false);
    expect(isTraceId("a,b")).toBe(false);
    expect(isTraceId(42)).toBe(false);
  });
});

describe("Trace context: bounds and providers", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case The rc member stays within the 256 characters W3C allows one value
   * @preconditions An envelope whose correlation id and cause are both 128 characters, the longest accepted
   * @expectedResult The member keeps the correlation id and leaves the exchange id off, and its value is at most 256 characters
   */
  test("tracestate stays within the W3C value limit", async () => {
    t = await testContext().build();
    const long = "c".repeat(128);
    const cause = "x".repeat(128);
    const envelope = new DefaultExchange(t.ctx, {
      headers: {
        [HeadersKeys.CORRELATION_ID]: long,
        [HeadersKeys.CAUSATION_ID]: cause,
      },
    });
    const { tracestate } = traceContextOf(envelope);
    expect(tracestate).toBe(`rc=c:${long}`);
    expect(tracestate.slice(3).length).toBeLessThanOrEqual(256);
  });

  /**
   * @case A traceparent of a later version is read by its known prefix
   * @preconditions A version 01 traceparent with an extra field, offered under "always"
   * @expectedResult It is adopted, and the remote parent is stored in version 00 form
   */
  test("adopts a later traceparent version by its prefix", () => {
    const adopted = adoptTraceContext(
      {
        traceparent:
          "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-future",
      },
      { mode: "always", authenticated: false },
    );
    expect(adopted[TRACE_PARENT_HEADER]).toBe(PARENT);
  });

  /**
   * @case A plugin other than the shipped telemetry names the outbound span through the TRACE_SPANS port
   * @preconditions A third-party plugin provides TRACE_SPANS answering a fixed span for one exchange
   * @expectedResult traceContextOf for that exchange sends the provided trace and span ids with the provided flags
   */
  test("a third-party span provider names the outbound traceparent", async () => {
    const spanFor = new Map<string, string>();
    t = await testContext()
      .with({
        plugins: [
          {
            id: "acme.tracing",
            provides: [TRACE_SPANS],
            bind(c) {
              c.provide(TRACE_SPANS, {
                spanOf: (id) =>
                  spanFor.has(id)
                    ? {
                        traceId: "a".repeat(32),
                        spanId: "b".repeat(16),
                        traceFlags: 1,
                      }
                    : undefined,
              });
            },
          },
        ],
      })
      .build();
    const exchange = new DefaultExchange(t.ctx, { body: {} });
    const { setExchangeRoute } = await import("../src/exchange.ts");
    setExchangeRoute(exchange, { definition: { id: "r" } } as never);
    spanFor.set(exchange.id, "yes");
    expect(traceContextOf(exchange).traceparent).toBe(
      `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    );
  });

  /**
   * @case Every door refuses a trace-context mode it does not know, and a remote a non-boolean
   * @preconditions httpPlugin, opsPlugin and remotesPlugin each given an invalid traceContext
   * @expectedResult Building a context with each fails with RC5003
   */
  test("option validation refuses unknown modes", async () => {
    const builds = [
      () =>
        testContext()
          .with({
            plugins: [
              httpPlugin({ traceContext: "sometimes" as TraceContextMode }),
            ],
          })
          .build(),
      () =>
        testContext()
          .with({
            plugins: [
              opsPlugin({ traceContext: "sometimes" as TraceContextMode }),
            ],
          })
          .build(),
      () =>
        testContext()
          .with({
            plugins: [
              remotesPlugin({
                lab: {
                  url: "http://127.0.0.1:1",
                  traceContext: "yes" as unknown as boolean,
                },
              }),
            ],
          })
          .build(),
    ];
    for (const build of builds) {
      await expect((async () => build())()).rejects.toMatchObject({
        rc: "RC5003",
      });
    }
  });
});

describe("Trace context: doors and clients", () => {
  let t: TestContext | undefined;
  let other: TestContext | undefined;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    if (other) await other.stop();
    if (close) await close();
    t = undefined;
    other = undefined;
    close = undefined;
  });

  async function httpDoor(
    config: CraftConfig,
    seen: ReturnType<typeof ids>[],
  ): Promise<number> {
    t = await testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        ...config,
      } as CraftConfig)
      .routes(
        craft()
          .id("door")
          .from(http({ path: "/in", method: "POST" }))
          .process((ex) => {
            seen.push(ids(ex));
            return ex;
          })
          .transform(() => ({ ok: true }))
          .to(noop()),
      )
      .build();
    return listen(t);
  }

  const traced = {
    traceparent: PARENT,
    tracestate: "rc=c:journey-1;x:exchange-9",
  };

  /**
   * @case The http door ignores an unauthenticated caller's context by default
   * @preconditions An http mount with no auth; a POST carrying traceparent and tracestate
   * @expectedResult The exchange starts a new chain: a fresh correlation id, no cause, no remote parent
   */
  test("http door: unauthenticated context is ignored by default", async () => {
    const seen: ReturnType<typeof ids>[] = [];
    const port = await httpDoor({ http: {} } as CraftConfig, seen);
    await fetch(`http://127.0.0.1:${port}/in`, {
      method: "POST",
      headers: { "content-type": "application/json", ...traced },
      body: "{}",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.correlationId).not.toBe("journey-1");
    expect(seen[0]!.causationId).toBeUndefined();
    expect(seen[0]!.remoteParent).toBeUndefined();
  });

  /**
   * @case The http door adopts any caller's context under "always"
   * @preconditions An http mount with no auth and traceContext "always"
   * @expectedResult The exchange carries the caller's correlation id, its exchange as the cause, and the remote parent
   */
  test('http door: "always" adopts an unauthenticated context', async () => {
    const seen: ReturnType<typeof ids>[] = [];
    const port = await httpDoor(
      { http: { traceContext: "always" } } as CraftConfig,
      seen,
    );
    await fetch(`http://127.0.0.1:${port}/in`, {
      method: "POST",
      headers: { "content-type": "application/json", ...traced },
      body: "{}",
    });
    expect(seen[0]).toMatchObject({
      correlationId: "journey-1",
      causationId: "exchange-9",
      remoteParent: PARENT,
    });
  });

  /**
   * @case The http door adopts an authenticated caller's context by default, before the first plugin hook
   * @preconditions An http mount walled by a JWT validator; a plugin with a beforeAuth observe hook; a POST with a valid bearer and a trace context
   * @expectedResult The exchange carries the caller's correlation id and cause, and the beforeAuth hook already sees both
   */
  test("http door: authenticated context is adopted by default", async () => {
    const seen: ReturnType<typeof ids>[] = [];
    const early: ReturnType<typeof ids>[] = [];
    const port = await httpDoor(
      {
        http: {
          auth: jwt({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE }),
        },
        plugins: [beforeAuthWitness(early)],
      } as CraftConfig,
      seen,
    );
    const res = await fetch(`http://127.0.0.1:${port}/in`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer()}`,
        ...traced,
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      correlationId: "journey-1",
      causationId: "exchange-9",
    });
    expect(early).toEqual([seen[0]!]);
  });

  /**
   * @case A direct() call from an adopted exchange does not hand the callee the remote parent
   * @preconditions An "always" door that calls a second route through direct()
   * @expectedResult The callee has the door exchange as its cause and no remote parent
   */
  test("http door: a callee's parent is its caller, not the remote", async () => {
    const callee: ReturnType<typeof ids>[] = [];
    let door: ReturnType<typeof ids> | undefined;
    t = await testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        http: { traceContext: "always" },
      } as CraftConfig)
      .routes([
        craft()
          .id("adopting-door")
          .from(http({ path: "/in", method: "POST" }))
          .process((ex) => {
            door = ids(ex);
            return ex;
          })
          .to(direct("traced-callee")),
        craft()
          .id("traced-callee")
          .from(direct())
          .process((ex) => {
            callee.push(ids(ex));
            return ex;
          })
          .to(noop()),
      ])
      .build();
    const port = await listen(t);
    await fetch(`http://127.0.0.1:${port}/in`, {
      method: "POST",
      headers: { "content-type": "application/json", ...traced },
      body: "{}",
    });
    expect(callee[0]!.correlationId).toBe("journey-1");
    expect(callee[0]!.causationId).toBe(door!.id);
    expect(callee[0]!.remoteParent).toBeUndefined();
  });

  async function recorder(): Promise<{
    port: number;
    requests: IncomingHttpHeaders[];
  }> {
    const requests: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      requests.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    close = () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    return { port: (server.address() as AddressInfo).port, requests };
  }

  /**
   * @case The http() client sends the exchange's trace context by default, and not when told not to
   * @preconditions Three routes call a recording server: one with defaults, one with traceContext false, one setting its own traceparent
   * @expectedResult The default call carries traceparent and an rc tracestate naming the exchange; the opted-out call carries neither; the route's own traceparent is sent untouched with no tracestate added
   */
  test("http() client: on by default, opt-out, route header wins", async () => {
    const { port, requests } = await recorder();
    let sender: ReturnType<typeof ids> | undefined;
    const url = `http://127.0.0.1:${port}/out`;
    t = await testContext()
      .routes([
        craft()
          .id("sends-default")
          .from(simple("a"))
          .process((ex) => {
            sender = ids(ex);
            return ex;
          })
          .to(http({ url, method: "POST", body: { n: 1 } })),
        craft()
          .id("sends-nothing")
          .from(simple("b"))
          .to(
            http({ url, method: "POST", body: { n: 2 }, traceContext: false }),
          ),
        craft()
          .id("sends-own")
          .from(simple("c"))
          .to(
            http({
              url,
              method: "POST",
              body: { n: 3 },
              headers: { traceparent: PARENT },
            }),
          ),
      ])
      .build();
    await t.test();

    expect(requests).toHaveLength(3);
    const byTrace = (value: string | undefined) =>
      requests.filter((h) => h["traceparent"] === value);
    const own = byTrace(PARENT);
    expect(own).toHaveLength(1);
    expect(own[0]!["tracestate"]).toBeUndefined();
    expect(byTrace(undefined)).toHaveLength(1);
    const sent = requests.find(
      (h) => h["traceparent"] !== undefined && h["traceparent"] !== PARENT,
    )!;
    expect(sent["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(sent["tracestate"]).toBe(
      `rc=c:${sender!.correlationId};x:${sender!.id}`,
    );
    // Without telemetry the trace id is the correlation UUID's 32 digits.
    expect(sent["traceparent"]).toContain(
      sender!.correlationId.replace(/-/g, ""),
    );
  });

  /**
   * @case The trace headers are added beside what a route signed, never inside it
   * @preconditions A route whose headers callback signs the method, path and body with an HMAC and sends the digest and the list of signed headers, as a vendor's request signing does; a recording server
   * @expectedResult The request carries the route's signature headers byte for byte and the engine's traceparent and tracestate beside them: the callback runs first and never sees the trace headers, so they are outside every header it signed, and the body is untouched
   */
  test("http() client: trace headers sit beside a route's signature", async () => {
    const { port, requests } = await recorder();
    const body = JSON.stringify({ amount: 10 });
    const sign = (payload: string) =>
      createHmac("sha256", "vendor-secret").update(payload).digest("hex");
    let signedOver: string[] | undefined;
    t = await testContext()
      .routes(
        craft()
          .id("signs")
          .from(simple("pay"))
          .to(
            http({
              url: `http://127.0.0.1:${port}/pay`,
              method: "POST",
              body,
              headers: () => {
                const headers = { "content-type": "application/json" };
                signedOver = Object.keys(headers);
                return {
                  ...headers,
                  "x-signed-headers": signedOver.join(";"),
                  "x-signature": sign(`POST /pay ${body}`),
                };
              },
            }),
          ),
      )
      .build();
    await t.test();

    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(sent["x-signature"]).toBe(sign(`POST /pay ${body}`));
    expect(sent["x-signed-headers"]).toBe("content-type");
    expect(signedOver).toEqual(["content-type"]);
    expect(sent["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(sent["tracestate"]).toMatch(/^rc=c:/);
  });

  /**
   * @case An empty traceparent the route set counts as unset, as an empty Content-Type does
   * @preconditions A route calling a recording server with headers TraceParent and tracestate set to the empty string, as a callback building headers with `?? ""` does
   * @expectedResult The engine's traceparent and rc tracestate are sent, once each, in place of the empty values
   */
  test("http() client: an empty route header is replaced", async () => {
    const { port, requests } = await recorder();
    let sender: ReturnType<typeof ids> | undefined;
    t = await testContext()
      .routes(
        craft()
          .id("sends-empty")
          .from(simple("a"))
          .process((ex) => {
            sender = ids(ex);
            return ex;
          })
          .to(
            http({
              url: `http://127.0.0.1:${port}/out`,
              headers: { TraceParent: "", tracestate: "" },
            }),
          ),
      )
      .build();
    await t.test();

    expect(requests).toHaveLength(1);
    expect(requests[0]!["traceparent"]).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/,
    );
    expect(requests[0]!["tracestate"]).toBe(
      `rc=c:${sender!.correlationId};x:${sender!.id}`,
    );
  });

  /**
   * @case traceContextOf names an envelope's cause rather than the envelope
   * @preconditions A route-less exchange built with a causation id, as CraftClient or an agent tool builds one
   * @expectedResult The rc member's x field is the causation id
   */
  test("traceContextOf: an envelope names its cause", async () => {
    t = await testContext().build();
    const { DefaultExchange } = await import("../src/exchange.ts");
    const envelope = new DefaultExchange(t.ctx, {
      body: {},
      headers: {
        [HeadersKeys.CORRELATION_ID]: "journey-1",
        [HeadersKeys.CAUSATION_ID]: "turn-7",
      },
    });
    expect(traceContextOf(envelope).tracestate).toBe("rc=c:journey-1;x:turn-7");
  });

  /**
   * @case One journey across two contexts through the remotes channel
   * @preconditions A server context with an ops dispatch tier behind a JWT wall; a local context imports its route, and a local route called through CraftClient calls it through direct()
   * @expectedResult The server's exchange carries the local exchange's correlation id and the local exchange as its cause
   */
  test("remotes: correlation and causation cross the hop", async () => {
    const remote: ReturnType<typeof ids>[] = [];
    let local: ReturnType<typeof ids> | undefined;
    other = await testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: [
          opsPlugin({
            auth: jwt({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE }),
            tiers: { introspection: "ops:dispatch", dispatch: "ops:dispatch" },
          }),
        ],
      })
      .routes(
        craft()
          .id("far")
          .description("A route on the other instance")
          .input({ body: z.object({}) })
          .from(direct())
          .process((ex) => {
            remote.push(ids(ex));
            return ex;
          })
          .transform(() => ({ ok: true }))
          .to(noop()),
      )
      .build();
    const port = await listen(other);

    t = await testContext()
      .with({
        remotes: {
          default: {
            url: `http://127.0.0.1:${port}`,
            auth: { token: () => bearer() },
          },
        },
      } as CraftConfig)
      .routes(
        craft()
          .id("near")
          .from(direct())
          .process((ex) => {
            local = ids(ex);
            return ex;
          })
          .to(direct("far")),
      )
      .build();
    // Ready once the remote's inventory is read, so "far" is an endpoint.
    await t.startAndWaitReady();
    await t.client.sendDirect("near", {});

    expect(remote).toHaveLength(1);
    expect(remote[0]!.correlationId).toBe(local!.correlationId);
    expect(remote[0]!.causationId).toBe(local!.id);
  });

  /**
   * @case A mount's own traceContext overrides the plugin's
   * @preconditions httpPlugin traceContext "never", with the default mount setting "always"; an unauthenticated POST carrying a trace context
   * @expectedResult The mount's "always" wins: the exchange carries the caller's correlation id
   */
  test("http door: a mount's traceContext wins over the plugin's", async () => {
    const seen: ReturnType<typeof ids>[] = [];
    const port = await httpDoor(
      {
        http: {
          traceContext: "never",
          mounts: { default: { path: "/", traceContext: "always" } },
        },
      } as CraftConfig,
      seen,
    );
    await fetch(`http://127.0.0.1:${port}/in`, {
      method: "POST",
      headers: { "content-type": "application/json", ...traced },
      body: "{}",
    });
    expect(seen[0]?.correlationId).toBe("journey-1");
  });

  /**
   * @case The ops dispatch mount adopts any caller's context under "always"
   * @preconditions opsPlugin with an open dispatch tier and traceContext "always"; a plugin with a beforeAuth observe hook; an anonymous dispatch carrying a trace context
   * @expectedResult The dispatched exchange carries the caller's correlation id and cause, and the beforeAuth hook already sees both
   */
  test('ops door: "always" adopts an anonymous dispatch\'s context', async () => {
    const seen: ReturnType<typeof ids>[] = [];
    const early: ReturnType<typeof ids>[] = [];
    other = await testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        plugins: [
          opsPlugin({ tiers: { dispatch: true }, traceContext: "always" }),
          beforeAuthWitness(early),
        ],
      })
      .routes(
        craft()
          .id("dispatched")
          .description("Dispatched by the ops door")
          .input({ body: z.object({}) })
          .from(direct())
          .process((ex) => {
            seen.push(ids(ex));
            return ex;
          })
          .to(noop()),
      )
      .build();
    const port = await listen(other);
    const res = await fetch(
      `http://127.0.0.1:${port}/ops/routes/dispatched/exchanges`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...traced },
        body: "{}",
      },
    );
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      correlationId: "journey-1",
      causationId: "exchange-9",
    });
    expect(early).toEqual([seen[0]!]);
  });

  /**
   * @case A remote's own traceContext decides, and an unset one follows the config's outbound default
   * @preconditions The two-context remotes setup, run three times: the remote set to false; the remote unset under traceContext { outbound: false }; the remote set to true under the same default
   * @expectedResult The first two start their own journey on the remote (a different correlation id, no cause); the third continues the caller's, because the remote's own true wins over the default
   */
  test("remotes: the remote's setting wins, else the outbound default", async () => {
    const cases: Array<{
      remote: boolean | undefined;
      outbound: boolean | undefined;
      sends: boolean;
    }> = [
      { remote: false, outbound: undefined, sends: false },
      { remote: undefined, outbound: false, sends: false },
      { remote: true, outbound: false, sends: true },
    ];
    for (const { remote: setting, outbound, sends } of cases) {
      const remote: ReturnType<typeof ids>[] = [];
      let local: ReturnType<typeof ids> | undefined;
      other = await testContext()
        .with({
          servers: { default: { port: 0, host: "127.0.0.1" } },
          plugins: [
            opsPlugin({
              auth: jwt({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE }),
              tiers: {
                introspection: "ops:dispatch",
                dispatch: "ops:dispatch",
              },
            }),
          ],
        })
        .routes(
          craft()
            .id("far-quiet")
            .description("A route on the other instance")
            .input({ body: z.object({}) })
            .from(direct())
            .process((ex) => {
              remote.push(ids(ex));
              return ex;
            })
            .to(noop()),
        )
        .build();
      const port = await listen(other);
      t = await testContext()
        .with({
          ...(outbound !== undefined ? { traceContext: { outbound } } : {}),
          remotes: {
            default: {
              url: `http://127.0.0.1:${port}`,
              auth: { token: () => bearer() },
              ...(setting !== undefined ? { traceContext: setting } : {}),
            },
          },
        } as CraftConfig)
        .routes(
          craft()
            .id("near-quiet")
            .from(direct())
            .process((ex) => {
              local = ids(ex);
              return ex;
            })
            .to(direct("far-quiet")),
        )
        .build();
      await t.startAndWaitReady();
      await t.client.sendDirect("near-quiet", {});

      expect(remote).toHaveLength(1);
      if (sends) {
        expect(remote[0]!.correlationId).toBe(local!.correlationId);
        expect(remote[0]!.causationId).toBe(local!.id);
      } else {
        expect(remote[0]!.correlationId).not.toBe(local!.correlationId);
        expect(remote[0]!.causationId).toBeUndefined();
      }
      await t.stop();
      await other.stop();
      t = undefined;
      other = undefined;
    }
  });

  /**
   * @case The config's outbound default stops the http() client, and a call's own traceContext still wins
   * @preconditions traceContext { outbound: false } in the config; one route calls a recording server with defaults, one with traceContext true
   * @expectedResult The default call carries neither header; the call that opts in carries traceparent and its rc tracestate
   */
  test("http() client: the outbound default applies, a call's own setting wins", async () => {
    const { port, requests } = await recorder();
    const url = `http://127.0.0.1:${port}/out`;
    t = await testContext()
      .with({ traceContext: { outbound: false } })
      .routes([
        craft()
          .id("quiet-by-default")
          .from(simple("a"))
          .to(http({ url, headers: { "x-route": "default" } })),
        craft()
          .id("opts-in")
          .from(simple("b"))
          .to(
            http({ url, headers: { "x-route": "opt-in" }, traceContext: true }),
          ),
      ])
      .build();
    await t.test();

    const byRoute = (route: string) =>
      requests.find((h) => h["x-route"] === route)!;
    expect(byRoute("default")["traceparent"]).toBeUndefined();
    expect(byRoute("default")["tracestate"]).toBeUndefined();
    expect(byRoute("opt-in")["traceparent"]).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/,
    );
    expect(byRoute("opt-in")["tracestate"]).toMatch(/^rc=c:/);
  });

  /**
   * @case traceContext.outbound is refused unless it is a boolean
   * @preconditions A context built with traceContext { outbound: "false" }, and one with traceContext "off"
   * @expectedResult Both are refused with RC5003 naming the key: a string "false" from an environment variable would otherwise read as on
   */
  test("the outbound default must be a boolean", () => {
    for (const traceContext of [{ outbound: "false" }, "off"]) {
      expect(
        () => new CraftContext({ traceContext } as unknown as CraftConfig),
      ).toThrow(
        expect.objectContaining({
          rc: "RC5003",
          message: expect.stringContaining("traceContext"),
        }),
      );
    }
  });
});
