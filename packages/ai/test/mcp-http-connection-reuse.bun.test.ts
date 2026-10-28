import { afterEach, describe, expect, test } from "bun:test";
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
    expect(remote.counts).toEqual({ initialize: 1, call: 2 });
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
   * @preconditions The remote forgets its sessions after the listing, so the next call carries an unknown Mcp-Session-Id and gets 404
   * @expectedResult The call answers, through a second initialize, and the remote ran the tool once
   */
  test("a stale session reconnects and resends once", async () => {
    const { remote, service } = await start();
    remote.dropSessions();
    expect(await dispatchMcpCall(service, "remote", "echo", {})).toBe("pong");
    expect(remote.counts).toEqual({ initialize: 2, call: 1 });
  });

  /**
   * @case A second 404 is a failure, not another resend
   * @preconditions The remote answers 404 to every session request from now on
   * @expectedResult The call fails with RC5003 after exactly one reconnect
   */
  test("a second 404 fails", async () => {
    const { remote, service } = await start();
    remote.forgetEverySession();
    await expect(
      dispatchMcpCall(service, "remote", "echo", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(remote.counts.initialize).toBe(2);
  });

  /**
   * @case A transport failure is reported, not resent, and evicts the connection
   * @preconditions The remote answers the next tools/call with HTTP 500
   * @expectedResult The call fails with RC5003 and the tool ran no second time; the next call reconnects
   */
  test("a transport failure evicts without a resend", async () => {
    const { remote, service } = await start();
    remote.failNextCall();
    await expect(
      dispatchMcpCall(service, "remote", "echo", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(remote.counts).toEqual({ initialize: 1, call: 1 });
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
   * @case A call after the plugin stopped opens no connection
   * @preconditions The context is stopped, closing the connections
   * @expectedResult The call fails with RC5003 and the remote saw no new initialize
   */
  test("a call after stop is refused", async () => {
    const { remote, service } = await start();
    await t!.stop();
    t = undefined;
    await expect(
      dispatchMcpCall(service, "remote", "echo", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(remote.counts.initialize).toBe(1);
  });
});
