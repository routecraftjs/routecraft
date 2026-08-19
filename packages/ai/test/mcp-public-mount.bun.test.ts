import { describe, test, expect, afterEach } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, noop, type Principal } from "@routecraft/routecraft";
import { mcp, mcpPlugin } from "../src/index.ts";
import { rpcBody } from "./fixtures/rpc-body.ts";

const INIT_PARAMS = {
  protocolVersion: "2024-11-05" as const,
  capabilities: {},
  clientInfo: { name: "test", version: "1.0.0" },
};

/**
 * The MCP surface with `auth: false` on a server that carries a validator.
 * `false` removes the wall, the scope demands, and the challenge, but the
 * inherited validator stays reachable, so the three credential postures a
 * caller can arrive with each have a pinned outcome: nothing demanded of the
 * anonymous, nothing worse for the holder of a bad token than for the
 * anonymous, and a principal attached for a token the validator admits.
 */
describe("MCP on an opted-out mount over a secured server", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
  });

  async function boot(): Promise<{
    call: (
      token?: string,
    ) => Promise<{ status: number; principal: Principal | undefined }>;
  }> {
    let captured: Principal | undefined;
    let port = 0;
    t = await testContext()
      .on("server:listening", ({ details }) => {
        port = details.port;
      })
      .routes([
        craft()
          .id("whoami")
          .description("Capture the principal, if any")
          .from(mcp())
          .tap((ex) => {
            captured = ex.principal;
          })
          .to(noop()),
      ])
      .with({
        servers: {
          default: {
            host: "127.0.0.1",
            port: 0,
            auth: {
              validator: (token: string) => {
                if (token !== "good-token") throw new Error("bad token");
                return {
                  kind: "custom" as const,
                  scheme: "bearer" as const,
                  subject: "user-7",
                };
              },
            },
          },
        },
        plugins: [mcpPlugin({ transport: "http", auth: false })],
      })
      .build();
    await t.startAndWaitReady();
    expect(port).toBeGreaterThan(0);

    async function post(
      body: unknown,
      token?: string,
    ): Promise<{ status: number; body: string }> {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: rpcBody(await res.text()) };
    }

    return {
      call: async (token?: string) => {
        captured = undefined;
        const init = await post(
          { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS },
          token,
        );
        expect(init.status).toBe(200);
        const call = await post(
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "whoami", arguments: {} },
          },
          token,
        );
        return { status: call.status, principal: captured };
      },
    };
  }

  /**
   * @case An anonymous caller is served with no principal
   * @preconditions mcp auth false, server validator present, no Authorization header
   * @expectedResult 200 and the tool runs anonymously. No wall means no demand, so the missing header is never challenged
   */
  test("serves an anonymous caller", async () => {
    const { call } = await boot();
    const result = await call();
    expect(result.status).toBe(200);
    expect(result.principal).toBeUndefined();
  });

  /**
   * @case An invalid token is treated as absent
   * @preconditions mcp auth false, server validator rejects the token
   * @expectedResult 200 and the tool runs anonymously. On a surface with no wall a credential must never make the caller worse off than presenting nothing; a 401 here would be a wall for token-holders only
   */
  test("serves a caller presenting an invalid token anonymously", async () => {
    const { call } = await boot();
    const result = await call("expired-or-forged");
    expect(result.status).toBe(200);
    expect(result.principal).toBeUndefined();
  });

  /**
   * @case A valid token attaches a principal
   * @preconditions mcp auth false, server validator admits the token
   * @expectedResult 200 and the tool sees the principal. The inherited validator stays reachable on an opted-out mount, which is what lets a tool's .authorize() admit on a public surface
   */
  test("attaches the principal for a token the inherited validator admits", async () => {
    const { call } = await boot();
    const result = await call("good-token");
    expect(result.status).toBe(200);
    expect(result.principal?.subject).toBe("user-7");
  });
});
