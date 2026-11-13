import { afterEach, describe, expect, test } from "bun:test";
import { craft, type AnyRouteBuilder } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { mcp, mcpPlugin } from "../src/index.ts";

/** What the MCP plugin says at start about the routes in front of each client. */
describe("the proxy coverage of MCP clients at start", () => {
  let t: TestContext | undefined;
  const realFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (t) await t.stop();
    t = undefined;
  });

  async function start(
    routes: AnyRouteBuilder[],
  ): Promise<Array<[Record<string, unknown>, string]>> {
    globalThis.fetch = (async () =>
      new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
    t = await testContext()
      .routes(routes)
      .with({
        plugins: [
          mcpPlugin({
            clients: {
              docs: { url: "https://docs.test/mcp" },
              billing: { url: "https://billing.test/mcp" },
              crm: { url: "https://crm.test/mcp" },
            },
          }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    return (
      t.contextLogger.info.mock.calls as Array<
        [Record<string, unknown>, string]
      >
    ).filter(
      ([, message]) =>
        typeof message === "string" && message.startsWith("MCP client is "),
    );
  }

  /**
   * @case Each client is reported once at start with the routes in front of it
   * @preconditions A star route over docs with an exclusion and an exact route for one docs tool; one exact route over billing; no route over crm
   * @expectedResult docs is reported proxied with its star route, own-route tool and exclusion; billing partly proxied with the tool its route names; crm not proxied
   */
  test("proxied, partly proxied and unproxied clients are told apart", async () => {
    const lines = await start([
      craft()
        .id("docs")
        .from(mcp({ proxy: "docs:*", exclude: ["delete_document"] }))
        .to(mcp("docs:*")),
      craft()
        .id("docs-search")
        .from(mcp({ proxy: "docs:search" }))
        .to(mcp("docs:search")),
      craft()
        .id("invoices")
        .from(mcp({ proxy: "billing:list_invoices" }))
        .to(mcp("billing:list_invoices")),
    ]);
    const byClient = new Map(
      lines.map(([bindings, message]) => [
        bindings["client"],
        [bindings, message],
      ]),
    );
    expect(lines).toHaveLength(3);
    expect(byClient.get("docs")).toEqual([
      {
        client: "docs",
        route: "docs",
        ownRoute: ["search"],
        excluded: ["delete_document"],
      },
      expect.stringContaining("is proxied"),
    ]);
    expect(byClient.get("billing")).toEqual([
      { client: "billing", proxied: ["list_invoices"] },
      expect.stringContaining("is partly proxied"),
    ]);
    expect(byClient.get("crm")).toEqual([
      { client: "crm" },
      expect.stringContaining("is not proxied"),
    ]);
  });
});
