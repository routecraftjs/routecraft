import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  acpPlugin,
  agentPlugin,
  llmPlugin,
  mcpPlugin,
  MemorySessionStore,
} from "../../../ai/src/index.ts";
import { MemoryDeferralStore } from "../../src/index.ts";

/** Cross-runtime contract for the MCP mount on named shared ingress. */
describe("MCP named ingress (cross-runtime contract)", () => {
  let context: TestContext | undefined;

  afterEach(async () => {
    if (context !== undefined) {
      await context.stop();
      context = undefined;
    }
  });

  /**
   * @case MCP metadata and auth use the runtime-specific shared listener
   * @preconditions Named ephemeral server with an authenticated MCP mount
   * @expectedResult Discovery is public and identical with no token or a rejected token, while the protected MCP path returns 401
   */
  test("serves public discovery and protects MCP on one named listener", async () => {
    let port = 0;
    context = await testContext()
      .on("server:listening", ({ details }) => {
        port = details.port;
      })
      .with({
        servers: { default: { host: "127.0.0.1", port: 0 } },
        plugins: [
          mcpPlugin({
            transport: "http",
            auth: {
              validator: () => {
                throw new Error("rejected token");
              },
            },
            resource: { url: "https://mcp.example.test/mcp" },
          }),
        ],
      })
      .build();
    await context.startAndWaitReady();
    expect(port).toBeGreaterThan(0);

    const metadataUrl = `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`;
    const anonymous = await fetch(metadataUrl);
    const rejected = await fetch(metadataUrl, {
      headers: { authorization: "Bearer stale" },
    });
    expect(anonymous.status).toBe(200);
    expect(rejected.status).toBe(200);
    expect(await rejected.text()).toBe(await anonymous.text());

    const protectedResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer stale",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(protectedResponse.status).toBe(401);
  });
  /**
   * @case Host and browser admission are enforced through both runtime listeners
   * @preconditions Each real protocol mount has proxy-owned CORS and an explicit trusted hostname
   * @expectedResult Native discovery succeeds on trusted hosts; foreign Host and unapproved Origin fail with 403
   */
  test.each(["mcp", "acp"])(
    "gates %s with proxy-owned CORS",
    async (protocol) => {
      let port = 0;
      context = await testContext()
        .on("server:listening", ({ details }) => {
          port = details.port;
        })
        .with({
          servers: {
            default: {
              host: "127.0.0.1",
              port: 0,
              allowedHostnames: ["agents.example"],
            },
          },
          deferral: { store: new MemoryDeferralStore() },
          sessions: { store: new MemorySessionStore() },
          plugins:
            protocol === "mcp"
              ? [mcpPlugin({ transport: "http", cors: false })]
              : [
                  llmPlugin({ providers: { anthropic: { apiKey: "unused" } } }),
                  agentPlugin({
                    agents: {
                      test: {
                        description: "test",
                        model: "anthropic:claude-sonnet-4-6",
                        system: "test",
                      },
                    },
                  }),
                  acpPlugin({ cors: false }),
                ],
        })
        .build();
      await context.startAndWaitReady();
      const url = `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/${protocol}`;
      for (const [headers, status] of [
        [{}, 200],
        [{ Host: "agents.example" }, 200],
        [
          { Host: "attacker.example", "X-Forwarded-Host": "agents.example" },
          403,
        ],
        [{ Origin: "http://localhost:6274" }, 403],
      ] as const) {
        // Node fetch replaces an explicit Host with the URL authority.
        // node:http preserves it, so both runtimes receive the attack shape.
        const actual = await new Promise<number>((resolve, reject) => {
          const request = httpRequest(
            url,
            { headers, agent: false },
            (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode!));
            },
          );
          request.on("error", reject);
          request.end();
        });
        expect(actual).toBe(status);
      }
    },
  );
});
