import { afterEach, describe, expect, test } from "bun:test";
import { rcCodeOf } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { mcpPlugin } from "../src/index.ts";
import { useRealMcpSdk } from "./helpers/real-mcp-sdk.ts";

const prior = await useRealMcpSdk();

/** What an outbound MCP connection refuses before and while it talks to a remote. */
describe("outbound MCP requests", () => {
  let t: TestContext | undefined;
  const realFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A remote URL must be https
   * @preconditions URLs over https, over http to a loopback host, over http to another host with and without allowHttp, and with another scheme
   * @expectedResult https, loopback http and an allowed http pass; plain http and another scheme throw RC5003
   */
  test("a client url is https unless loopback or allowed", () => {
    const check =
      (url: string, allowHttp = false) =>
      () =>
        prior.assertRemoteUrl(url, allowHttp, "url");
    expect(check("https://mcp.example.com/mcp")).not.toThrow();
    expect(check("http://localhost:3000/mcp")).not.toThrow();
    expect(check("http://127.0.0.1:3000/mcp")).not.toThrow();
    expect(check("http://127.0.0.2:3000/mcp")).not.toThrow();
    expect(check("http://[::1]:3000/mcp")).not.toThrow();
    expect(check("http://10.0.0.5/mcp", true)).not.toThrow();
    for (const refused of [
      check("http://mcp.example.com/mcp"),
      check("http://localhost.example.com/mcp"),
      check("http://localhost@mcp.example.com/mcp"),
      check("ftp://mcp.example.com/mcp", true),
      check("not a url"),
    ]) {
      let code: string | undefined;
      try {
        refused();
      } catch (error) {
        code = rcCodeOf(error);
      }
      expect(code).toBe("RC5003");
    }
  });

  /**
   * @case A registered client over plain http fails the context build
   * @preconditions mcpPlugin with one client whose url is http to a host that is not loopback
   * @expectedResult build rejects with RC5003 naming the client
   */
  test("a plain http client fails at bind", async () => {
    const build = testContext()
      .with({
        plugins: [
          mcpPlugin({ clients: { vendor: { url: "http://vendor.test/mcp" } } }),
        ],
      })
      .build();
    const error = await build.then(
      (context) => {
        t = context;
        return undefined;
      },
      (cause: unknown) => cause,
    );
    expect(rcCodeOf(error)).toBe("RC5003");
    expect((error as Error).message).toContain("clients.vendor.url");
  });

  /**
   * @case A disabled client may leave its url unset
   * @preconditions mcpPlugin with one client whose url is undefined and whose enabled is a reason string
   * @expectedResult The context builds
   */
  test("a disabled client's url is not checked", async () => {
    t = await testContext()
      .with({
        plugins: [
          mcpPlugin({
            clients: {
              vendor: {
                url: undefined as unknown as string,
                enabled: "VENDOR_URL is unset",
              },
            },
          }),
        ],
      })
      .build();
    expect(t).toBeDefined();
  });

  /** Connect to remote.test with a secret header and return the failure and every URL asked. */
  async function connectAgainst(
    answer: (url: string) => Response,
  ): Promise<{ messages: string; requested: Request[] }> {
    const requested: Request[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = new Request(input, init);
      requested.push(request);
      return answer(request.url);
    }) as typeof fetch;
    const error = await prior
      .connectMcpHttpClient(new URL("https://remote.test/mcp"), {
        auth: { headers: { "x-api-key": "secret" } },
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    const messages: string[] = [];
    for (let e = error as Error | undefined; e; e = e.cause as Error) {
      messages.push(e.message);
    }
    return { messages: messages.join("\n"), requested };
  }

  /**
   * @case A redirect to another origin is not followed
   * @preconditions The remote answers every request with a 307 to another origin; the client sends a secret header
   * @expectedResult The connection fails saying the redirect was not followed, and no request, so no credential, reaches the other origin
   */
  test("a redirect to another origin fails the call and is not followed", async () => {
    const { messages, requested } = await connectAgainst(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://evil.test/mcp" },
        }),
    );
    expect(messages).toContain("not followed");
    expect(requested.length).toBeGreaterThan(0);
    expect(
      requested.every((request) =>
        request.url.startsWith("https://remote.test/"),
      ),
    ).toBe(true);
  });

  /**
   * @case A redirect within the configured origin is followed, with the credential
   * @preconditions The remote answers /mcp with a 307 to /mcp/ on the same origin, and anything else with 404
   * @expectedResult The request is repeated at /mcp/ carrying the secret header
   */
  test("a redirect within the origin is followed", async () => {
    const { requested } = await connectAgainst((url) =>
      url === "https://remote.test/mcp"
        ? new Response(null, {
            status: 307,
            headers: { location: "https://remote.test/mcp/" },
          })
        : new Response("Not Found", { status: 404 }),
    );
    const followed = requested.find(
      (request) => request.url === "https://remote.test/mcp/",
    );
    expect(followed?.headers.get("x-api-key")).toBe("secret");
  });
});
