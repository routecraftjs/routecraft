import { afterEach, describe, expect, mock, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  MemoryDeferralStore,
  type HttpServerDefinition,
} from "@routecraft/routecraft";
import {
  acpPlugin,
  agentPlugin,
  llmPlugin,
  mcpPlugin,
  MemorySessionStore,
} from "../src/index.ts";
import type { McpPluginOptions } from "../src/mcp/types.ts";
import { rpcResult } from "./fixtures/rpc-body.ts";

const BROWSER = "https://editor.example";
const corsModes = [undefined, { origin: "*" }, false] as const;

for (const protocol of ["mcp", "acp"] as const) {
  describe(`${protocol} shared ingress`, () => {
    let t: TestContext | undefined;
    let port = 0;
    afterEach(async () => {
      await t?.stop();
      t = undefined;
    });

    async function boot(
      options: Pick<
        McpPluginOptions,
        "resource" | "cors" | "browserOrigins" | "auth"
      > = {},
      server: Partial<HttpServerDefinition> = {},
    ) {
      t = await testContext()
        .on("server:listening", ({ details }) => {
          port = details.port;
        })
        .with({
          servers: { default: { host: "127.0.0.1", port: 0, ...server } },
          deferral: { store: new MemoryDeferralStore() },
          sessions: { store: new MemorySessionStore() },
          plugins:
            protocol === "mcp"
              ? [mcpPlugin({ transport: "http", ...options })]
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
                  acpPlugin(options),
                ],
        })
        .build();
      await t.startAndWaitReady();
    }

    function send(
      headers: Record<string, string> = {},
      method = "POST",
      path = `/${protocol}`,
    ) {
      return new Promise<{
        status: number;
        body: string;
        headers: import("node:http").IncomingHttpHeaders;
      }>((resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Connection: "close",
              ...headers,
            },
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                body,
                headers: response.headers,
              }),
            );
          },
        );
        request.on("error", reject);
        request.setTimeout(3000, () =>
          request.destroy(new Error("request timed out")),
        );
        request.end(
          method === "POST"
            ? JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params:
                  protocol === "mcp"
                    ? {
                        protocolVersion: "2025-11-25",
                        capabilities: {},
                        clientInfo: { name: "test-editor", version: "1" },
                      }
                    : {
                        protocolVersion: 1,
                        clientCapabilities: {},
                        clientInfo: { name: "test-editor", version: "1" },
                      },
              })
            : undefined,
        );
      });
    }

    for (const cors of corsModes) {
      describe(`cors=${JSON.stringify(cors)}`, () => {
        const options = cors === undefined ? {} : { cors };
        /**
         * @case Rebinding-shaped requests cannot initialize an unwalled protocol
         * @preconditions Loopback listener, no auth and each CORS mode
         * @expectedResult Correct Host without Origin initializes; foreign Host fails with and without Origin
         */
        test("rejects foreign Host while editor initialization works", async () => {
          await boot(options);
          const good = await send();
          expect(good.status).toBe(200);
          expect(rpcResult(good.body)["protocolVersion"]).toBeDefined();
          for (const headers of [
            { Host: "attacker.example" },
            { Host: "attacker.example", Origin: "http://attacker.example" },
          ]) {
            const bad = await send(headers);
            expect(bad.status).toBe(403);
            expect(JSON.parse(bad.body)).toEqual({ error: "Forbidden" });
          }
        });

        /**
         * @case A proxy's configured public hostname is trusted without learning from headers
         * @preconditions Public hostname differs from the loopback bind, each CORS mode
         * @expectedResult Configured public Host initializes; forwarding metadata cannot authorize a foreign Host
         */
        test("trusts explicit public hostnames, never forwarding headers", async () => {
          await boot(options, { allowedHostnames: ["agent.example"] });
          expect((await send({ Host: "AGENT.EXAMPLE:443" })).status).toBe(200);
          expect(
            (
              await send({
                Host: "attacker.example",
                Forwarded: "host=agent.example",
                "X-Forwarded-Host": "agent.example",
              })
            ).status,
          ).toBe(403);
          expect(
            (
              await send({
                Host: "new.example",
                Forwarded: "host=new.example",
                "X-Forwarded-Host": "new.example",
              })
            ).status,
          ).toBe(403);
        });

        /**
         * @case CORS configuration does not implicitly authorize browser access
         * @preconditions Correct Host, no browserOrigins opt-in, each CORS mode
         * @expectedResult Foreign and loopback Origin requests fail before SDK dispatch
         */
        test("requires a separate browser opt-in", async () => {
          await boot(options);
          for (const Origin of [BROWSER, "http://localhost:6274", "null", ""]) {
            expect((await send({ Origin })).status).toBe(403);
          }
        });

        /**
         * @case Removing the authentication wall does not remove ingress validation
         * @preconditions Mount auth false overrides inherited auth, with each CORS mode
         * @expectedResult Anonymous editor initializes while foreign Host is refused
         */
        test("retains the gate when auth is explicitly disabled", async () => {
          await boot(
            { ...options, auth: false },
            {
              auth: {
                validator: () => {
                  throw new Error("bad credential");
                },
              },
            },
          );
          expect((await send()).status).toBe(200);
          expect((await send({ Host: "attacker.example" })).status).toBe(403);
        });

        /**
         * @case Host validation precedes OPTIONS, discovery and credential verification
         * @preconditions Walled mount, a spy validator and each CORS mode
         * @expectedResult Foreign Host gets 403 on preflight and discovery; validator is untouched
         */
        test("gates preflight and discovery before authentication", async () => {
          const validator = mock(() => ({
            kind: "custom" as const,
            scheme: "bearer" as const,
            subject: "editor",
          }));
          await boot(options, { auth: { validator } });
          for (const [method, path] of [
            ["OPTIONS", `/${protocol}`],
            ["GET", `/.well-known/oauth-protected-resource/${protocol}`],
            ["POST", `/${protocol}`],
          ]) {
            expect(
              (
                await send(
                  { Host: "attacker.example", Authorization: "Bearer secret" },
                  method,
                  path,
                )
              ).status,
            ).toBe(403);
          }
          expect(validator).not.toHaveBeenCalled();
          expect((await send({ Authorization: "Bearer secret" })).status).toBe(
            200,
          );
          expect(validator).toHaveBeenCalledTimes(1);
        });
      });
    }

    /**
     * @case Browser admission and CORS must both allow the requested origin
     * @preconditions Explicit browserOrigins with matching CORS, followed by mismatched CORS
     * @expectedResult Authorized browser initializes and reads response; disallowed browser is refused
     */
    test("supports explicit browser access and preserves CORS refusal", async () => {
      await boot({
        browserOrigins: [BROWSER, "https://other.example"],
        cors: { origin: BROWSER },
      });
      const allowed = await send({ Origin: BROWSER });
      expect(allowed.status).toBe(200);
      expect(allowed.headers["access-control-allow-origin"]).toBe(BROWSER);
      expect((await send({ Origin: "https://other.example" })).status).toBe(
        403,
      );
      expect(
        (await send({ Origin: "https://other.example" }, "OPTIONS")).status,
      ).toBe(403);
      expect((await send({ Origin: "https://attacker.example" })).status).toBe(
        403,
      );
      expect(
        (await send({ Origin: BROWSER, Host: "attacker.example" })).status,
      ).toBe(403);
    });

    /**
     * @case Reverse proxy may own CORS while explicit browser admission remains enforced
     * @preconditions cors false and one browser origin opted in
     * @expectedResult Opted-in browser initializes without CORS headers; another browser fails
     */
    test("supports proxy-owned CORS with explicit browser access", async () => {
      await boot({ cors: false, browserOrigins: [BROWSER] });
      const good = await send({ Origin: BROWSER });
      expect(good.status).toBe(200);
      expect(good.headers["access-control-allow-origin"]).toBeUndefined();
      expect((await send({ Origin: "https://other.example" })).status).toBe(
        403,
      );
    });

    if (protocol === "mcp") {
      /**
       * @case MCP retains its canonical resource URL as a mount-specific trusted host
       * @preconditions Loopback bind and an explicit remote resource URL
       * @expectedResult The resource hostname initializes without a separate server allowlist
       */
      test("preserves resource.url hostname trust", async () => {
        await boot({
          resource: { url: "https://mcp.example/mcp" },
          cors: false,
        });
        expect((await send({ Host: "mcp.example" })).status).toBe(200);
        expect((await send({ Host: "other.example" })).status).toBe(403);
      });
    }
  });
}
