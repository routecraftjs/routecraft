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
import { statefulRemote } from "./helpers/stateful-remote.ts";

const URL_ = "http://remote.test/mcp";

// Another suite in the same process may have replaced the SDK loader seam
// with a mock client, and `mock.module` outlives the suite that set it. This
// suite drives the real client, so it puts the real loader back first, and
// hands back whatever loader it found once it is done.
const sdk = await import("../src/mcp/sdk.ts");
const prior = { ...sdk };
mock.module("../src/mcp/sdk.ts", () => ({
  ...prior,
  loadMcpClientSdk: async () => import("@modelcontextprotocol/client"),
}));
afterAll(() => {
  mock.module("../src/mcp/sdk.ts", () => prior);
});

/**
 * A registered HTTP client keeps one connection, shared by its tool listing
 * and every call, and a stale session is replaced and the call resent once.
 */
describe("HTTP MCP clients reuse one connection", () => {
  let t: TestContext | undefined;
  let remote: ReturnType<typeof statefulRemote> | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
    remote?.restore();
    remote = undefined;
  });

  async function start(routes: AnyRouteBuilder[] = []) {
    remote = statefulRemote(URL_);
    t = await testContext()
      .with({
        plugins: [
          mcpPlugin({
            clients: { remote: { url: URL_ } },
            toolRefreshInterval: 0,
          }),
        ],
      })
      // A long-lived route, so the context stays up between the calls.
      .routes([craft().id("idle").from(direct()).to(noop()), ...routes])
      .build();
    await t.startAndWaitReady();
    return { remote, service: t.ctx.lookup(MCP) };
  }

  /**
   * @case Two calls after the tool listing open no further connection
   * @preconditions A stateful remote registered as an HTTP client; the plugin listed its tools at bind
   * @expectedResult Both calls answer, and the remote saw exactly one initialize
   */
  test("two calls, one initialize", async () => {
    const { remote, service } = await start();
    expect(await dispatchMcpCall(service, "remote", "echo", {})).toBe("pong");
    expect(await dispatchMcpCall(service, "remote", "echo", {})).toBe("pong");
    expect(remote.counts).toMatchObject({ initialize: 1, call: 2 });
  });

  /**
   * @case A route's .to(mcp("client:tool")) hop uses the shared connection
   * @preconditions A route from a simple source calls the registered client's tool
   * @expectedResult The hop answers and the remote saw one initialize, the listing's
   */
  test("a route's hop uses the shared connection", async () => {
    let seen: unknown;
    const { remote } = await start([
      craft()
        .id("ask")
        .from(simple({}))
        .to(mcp("remote:echo"))
        .process((ex) => {
          seen = ex.body;
          return ex;
        }),
    ]);
    await t!.drain();
    expect(seen).toBe("pong");
    expect(remote.counts.initialize).toBe(1);
  });

  /**
   * @case A stale session is replaced and the call resent once
   * @preconditions One call on the shared connection, then the remote forgets its sessions, so the next call carries an unknown Mcp-Session-Id and gets 404
   * @expectedResult The second call answers through exactly one new initialize, two in all, and the remote ran the tool once per call
   */
  test("a stale session reconnects and resends once", async () => {
    const { remote, service } = await start();
    expect(await dispatchMcpCall(service, "remote", "echo", {})).toBe("pong");
    remote.dropSessions();
    expect(await dispatchMcpCall(service, "remote", "echo", {})).toBe("pong");
    expect(remote.counts).toMatchObject({ initialize: 2, call: 2 });
  });

  /**
   * @case A second 404 on the resent call is a failure, not another resend
   * @preconditions The remote answers every tools/call with the stale-session 404, while its handshake still succeeds
   * @expectedResult The call fails with RC5003 after one reconnect, the remote saw the call and its one resend, and no third attempt
   */
  test("a second 404 fails", async () => {
    const { remote, service } = await start();
    remote.staleOnEveryCall();
    await expect(
      dispatchMcpCall(service, "remote", "echo", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(remote.counts).toMatchObject({ initialize: 2, stale: 2 });
  });

  /**
   * @case An HTTP error status is reported, not resent, and keeps the connection
   * @preconditions The remote answers the next tools/call with HTTP 500
   * @expectedResult The call fails with RC5003, the remote ran no second attempt, and the next call reuses the session (no new initialize)
   */
  test("an HTTP error status keeps the connection without a resend", async () => {
    const { remote, service } = await start();
    remote.failNextCall();
    await expect(
      dispatchMcpCall(service, "remote", "echo", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(remote.counts).toMatchObject({ initialize: 1, call: 1 });
    expect(await dispatchMcpCall(service, "remote", "echo", {})).toBe("pong");
    expect(remote.counts).toMatchObject({ initialize: 1, call: 2 });
  });

  /**
   * @case A failure with no answer is reported, not resent, and evicts the connection
   * @preconditions The next tools/call fails before the remote answers, as a refused socket does
   * @expectedResult The call fails with RC5003 and nothing reached the tool; the next call reconnects
   */
  test("a failure without an answer evicts without a resend", async () => {
    const { remote, service } = await start();
    remote.throwNextCall();
    await expect(
      dispatchMcpCall(service, "remote", "echo", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(remote.counts).toMatchObject({ initialize: 1, call: 0 });
    expect(await dispatchMcpCall(service, "remote", "echo", {})).toBe("pong");
    expect(remote.counts.initialize).toBe(2);
  });

  /**
   * @case Evicting a connection does not fail the calls already in flight on it
   * @preconditions A slow call is in flight when a concurrent call on the same connection fails without an answer
   * @expectedResult The failing call fails, the slow call still answers once released, and a later call reconnects
   */
  test("an eviction lets the calls in flight finish", async () => {
    const { remote, service } = await start();
    const slow = dispatchMcpCall(service, "remote", "slow", {});
    // Let the slow call reach the remote before the failure evicts.
    while (remote.counts.call === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    remote.throwNextCall();
    await expect(
      dispatchMcpCall(service, "remote", "echo", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    remote.releaseSlow();
    expect(await slow).toBe("slow done");
    expect(await dispatchMcpCall(service, "remote", "echo", {})).toBe("pong");
    expect(remote.counts.initialize).toBe(2);
  });

  /**
   * @case A JSON-RPC error from the remote keeps the connection
   * @preconditions A call to a tool the remote does not have, which it answers with a JSON-RPC error
   * @expectedResult The call fails, and the next call reuses the connection (no second initialize)
   */
  test("a remote's JSON-RPC error keeps the connection", async () => {
    const { remote, service } = await start();
    await expect(
      dispatchMcpCall(service, "remote", "missing", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(await dispatchMcpCall(service, "remote", "echo", {})).toBe("pong");
    expect(remote.counts.initialize).toBe(1);
  });

  /**
   * @case Stopping ends the session and refuses later calls
   * @preconditions The context is stopped, closing the connections
   * @expectedResult The remote received the session DELETE, and a later call fails with RC5003 without a new initialize
   */
  test("stop ends the session and refuses later calls", async () => {
    const { remote, service } = await start();
    await t!.stop();
    t = undefined;
    expect(remote.counts.terminated).toBe(1);
    await expect(
      dispatchMcpCall(service, "remote", "echo", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(remote.counts.initialize).toBe(1);
  });
});
