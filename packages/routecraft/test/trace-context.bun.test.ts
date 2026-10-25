import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { signHs256, testContext, type TestContext } from "@routecraft/testing";
import {
  adoptTraceContext,
  craft,
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
  type TraceContextMode,
} from "../src/index.ts";
import { TRACE_PARENT_HEADER } from "../src/trace-context.ts";

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

async function listen(t: TestContext): Promise<number> {
  let port: number | undefined;
  t.ctx.on("server:listening", ({ details }) => {
    port = details.port;
  });
  await t.startAndWaitReady();
  if (port === undefined) throw new Error("no server reported a port");
  return port;
}

describe("Trace context: the wire format", () => {
  /**
   * @case Adoption follows the mode and the caller's authentication
   * @preconditions A well-formed traceparent and an rc tracestate member, offered under each mode with and without a verified principal
   * @expectedResult authenticated adopts only an authenticated caller, always adopts both, never adopts neither
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
    for (const result of [adopted(undefined, true), adopted("always", false)]) {
      expect(result).toEqual({
        [HeadersKeys.CORRELATION_ID]: "journey-1",
        [HeadersKeys.CAUSATION_ID]: "exchange-9",
        [TRACE_PARENT_HEADER]: PARENT,
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
   * @case The http door adopts an authenticated caller's context by default
   * @preconditions An http mount walled by a JWT validator; a POST with a valid bearer and a trace context
   * @expectedResult The exchange carries the caller's correlation id and cause
   */
  test("http door: authenticated context is adopted by default", async () => {
    const seen: ReturnType<typeof ids>[] = [];
    const port = await httpDoor(
      {
        http: {
          auth: jwt({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE }),
        },
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
});
