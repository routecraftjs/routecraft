import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import {
  craft,
  direct,
  noop,
  simple,
  type AnyRouteBuilder,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { mcp, mcpPlugin } from "../src/index.ts";
import { MCP } from "../src/mcp/port.ts";
import { dispatchMcpCall } from "../src/mcp/dispatch.ts";
import { transportFailure } from "../src/mcp/transport-failure.ts";
import { statefulRemote } from "./helpers/stateful-remote.ts";

const URL_ = "https://retry.test/mcp";

// `mock.module` outlives the suite that set it, so the real SDK loader is put
// back for this suite and the prior one restored after it.
const sdk = await import("../src/mcp/sdk.ts");
const prior = { ...sdk };
mock.module("../src/mcp/sdk.ts", () => ({
  ...prior,
  loadMcpClientSdk: async () => import("@modelcontextprotocol/client"),
}));
afterAll(() => {
  mock.module("../src/mcp/sdk.ts", () => prior);
});

/** A failure shaped like the SDK's HTTP error: a status beside the message. */
function httpFailure(status: number): Error {
  return Object.assign(
    new Error(`Error POSTing to endpoint (HTTP ${status})`),
    {
      status,
    },
  );
}

describe("MCP transport failures and .retry()", () => {
  let t: TestContext | undefined;
  let remote: ReturnType<typeof statefulRemote> | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
    remote?.restore();
    remote = undefined;
  });

  async function start(routes: AnyRouteBuilder[]) {
    remote = statefulRemote(URL_);
    const stopped: Array<Record<string, unknown>> = [];
    t = await testContext()
      .on("route:retry:stopped", (payload) => {
        stopped.push(payload.details as Record<string, unknown>);
      })
      .with({
        plugins: [
          mcpPlugin({
            clients: { remote: { url: URL_ } },
            toolRefreshInterval: 0,
          }),
        ],
      })
      .routes([craft().id("idle").from(direct()).to(noop()), ...routes])
      .build();
    await t.startAndWaitReady();
    return { remote, stopped };
  }

  /**
   * @case .retry() with the default retryOn re-attempts a thrown transport error
   * @preconditions A route whose mcp() hop is wrapped in .retry(); the remote's first tools/call fails before any answer, as a refused socket does
   * @expectedResult The hop answers on the second attempt, and the stopped event reports success on attempt 2
   */
  test("a thrown transport error is retried and succeeds", async () => {
    let seen: unknown;
    const started = await start([
      craft()
        .id("ask")
        .from(direct())
        .retry({ maxAttempts: 3, backoff: 1 })
        .to(mcp("remote:echo"))
        .process((ex) => {
          seen = ex.body;
          return ex;
        }),
    ]);
    started.remote.throwNextCall();
    await t!.client.sendDirect("ask", {});
    expect(seen).toBe("pong");
    expect(started.stopped).toHaveLength(1);
    expect(started.stopped[0]).toMatchObject({
      success: true,
      attemptNumber: 2,
    });
  });

  /**
   * @case An unregistered server is a misconfiguration and is never retried
   * @preconditions A .retry()-wrapped step dispatches to a client id nobody registered
   * @expectedResult The step ran once, the failure is RC5003, and the stopped event names the reason and the code
   */
  test("an unregistered server stays RC5003 and is not retried", async () => {
    let calls = 0;
    const started = await start([
      craft()
        .id("ghost")
        .from(simple({}))
        .retry({ maxAttempts: 3, backoff: 1 })
        .transform(async () => {
          calls++;
          return dispatchMcpCall(t!.ctx.lookup(MCP), "ghost", "echo", {});
        })
        .to(noop()),
    ]);
    await t!.drain();
    expect(calls).toBe(1);
    expect(started.stopped).toHaveLength(1);
    expect(started.stopped[0]).toMatchObject({
      success: false,
      attemptNumber: 1,
      reason: "not-retryable",
      code: "RC5003",
    });
  });

  /**
   * @case Each wire failure is named by what went wrong
   * @preconditions Failures shaped like the SDK's: HTTP statuses, an unauthorized error, timeouts at the top and inside a cause chain, a JSON-RPC error, and an unknown fault
   * @expectedResult Timeouts, rate limits, server errors and unknown faults are retryable; a refused credential, a missing resource, a JSON-RPC error and other client errors are not
   */
  test("classifies a failure by status, timeout and shape", () => {
    const stalled = Object.assign(new Error("Request timed out"), {
      code: "REQUEST_TIMEOUT",
    });
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    });
    const slowConnect = new TypeError("fetch failed", {
      cause: Object.assign(new Error("Connect Timeout Error"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    const probe = new Error(
      "Version negotiation probe timed out after 60000ms",
    );
    const unauthorized = Object.assign(new Error("Unauthorized"), {
      name: "UnauthorizedError",
    });
    const invalidUrl = Object.assign(new TypeError("Invalid URL"), {
      code: "ERR_INVALID_URL",
    });
    const jsonRpc = Object.assign(new Error("Unknown tool"), { code: -32602 });

    const cases: Array<[unknown, string, boolean]> = [
      [httpFailure(401), "RC5012", false],
      [unauthorized, "RC5012", false],
      [httpFailure(403), "RC5015", false],
      [httpFailure(404), "RC5014", false],
      [httpFailure(429), "RC5013", true],
      [httpFailure(408), "RC5011", true],
      [httpFailure(504), "RC5011", true],
      [httpFailure(400), "RC5003", false],
      [httpFailure(500), "RC5010", true],
      [stalled, "RC5011", true],
      [slowConnect, "RC5011", true],
      [probe, "RC5011", true],
      [refused, "RC5010", true],
      [jsonRpc, "RC5003", false],
      [invalidUrl, "RC5003", false],
      [new Error("Error POSTing to endpoint:"), "RC5010", true],
    ];
    for (const [cause, rc, retryable] of cases) {
      const failure = transportFailure(cause, "call failed");
      expect([failure.rc as string, failure.retryable]).toEqual([
        rc,
        retryable,
      ]);
      expect(failure.cause).toBe(cause);
    }
  });
});
