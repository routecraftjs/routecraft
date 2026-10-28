import { afterEach, describe, expect, test } from "bun:test";
import { craft, direct, noop, simple } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { mcp, mcpPlugin } from "../src/index.ts";
import { MCP } from "../src/mcp/port.ts";
import { dispatchMcpCall } from "../src/mcp/dispatch.ts";

const REMOTE = "http://remote.test/mcp";

/**
 * Capture the Authorization header of every request to the remote, and
 * answer each with a 500: the header the client sent is the point, not the
 * call's outcome.
 */
function captureAuthorization() {
  const seen: Array<string | null> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(REMOTE)) return original(input, init);
    seen.push(request.headers.get("authorization"));
    return new Response("unavailable", { status: 500 });
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = original) };
}

/**
 * A registered client is one identity: `auth` beside `serverId` is refused,
 * the registered auth is the one sent, and a route-owned credential goes on
 * an inline `url`.
 */
describe("mcp() auth beside serverId", () => {
  let t: TestContext | undefined;
  let capture: ReturnType<typeof captureAuthorization> | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
    capture?.restore();
    capture = undefined;
  });

  /**
   * @case auth beside serverId in the object form is refused at construction
   * @preconditions mcp({ serverId, tool, auth })
   * @expectedResult mcp() throws RC5003 naming the client
   */
  test("the object form is refused", () => {
    expect(() =>
      mcp({ serverId: "github", tool: "create_issue", auth: { token: "b" } }),
    ).toThrow(expect.objectContaining({ rc: "RC5003" }));
  });

  /**
   * @case auth beside the 'server:tool' shorthand is refused at construction
   * @preconditions mcp("github:create_issue", { auth }) from untyped code
   * @expectedResult mcp() throws RC5003
   */
  test("the shorthand form is refused", () => {
    expect(() =>
      mcp("github:create_issue", { auth: { token: "b" } } as never),
    ).toThrow(expect.objectContaining({ rc: "RC5003" }));
  });

  /**
   * @case A serverId call sends the client's registered auth
   * @preconditions A registered HTTP client with token A; a dispatch to it
   * @expectedResult Every request to the remote carries Bearer A
   */
  test("the registered auth is the one sent", async () => {
    capture = captureAuthorization();
    t = await testContext()
      .with({
        plugins: [
          mcpPlugin({
            clients: { remote: { url: REMOTE, auth: { token: "token-a" } } },
            toolRefreshInterval: 0,
          }),
        ],
      })
      .routes([craft().id("idle").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    capture.seen.length = 0;
    await expect(
      dispatchMcpCall(t.ctx.lookup(MCP), "remote", "echo", {}),
    ).rejects.toMatchObject({ rc: "RC5003" });
    expect(capture.seen.length).toBeGreaterThan(0);
    expect(new Set(capture.seen)).toEqual(new Set(["Bearer token-a"]));
  });

  /**
   * @case An inline url call sends the route's own auth
   * @preconditions A route whose .to(mcp({ url, tool, auth: { token: B } })) runs once
   * @expectedResult The request to the remote carries Bearer B
   */
  test("an inline url call sends its own auth", async () => {
    capture = captureAuthorization();
    t = await testContext()
      .routes([
        craft()
          .id("call")
          .from(simple({}))
          .to(mcp({ url: REMOTE, tool: "echo", auth: { token: "token-b" } })),
      ])
      .build();
    await t.startAndWaitReady();
    await t.drain();
    expect(capture.seen).toContain("Bearer token-b");
  });
});
