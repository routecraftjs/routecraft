import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { craft, type AnyRouteBuilder } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import type { McpServer } from "../src/mcp/server.ts";
import { mcpPort, mcpServerFor } from "./helpers/mcp-port.ts";
import { callTool } from "./helpers/mcp-tool-call.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import { mcp, tools } from "../src/index.ts";
import type { McpClientConfig } from "../src/mcp/port.ts";

/** A contact as the remote returns it, bank account included. */
const CONTACT = { id: "c-1", name: "Ada", bank_account: "NL00BANK0123" };

/** The remote's schemas: the output requires the bank account. */
const REMOTE_OUTPUT = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    bank_account: { type: "string" },
  },
  required: ["id", "name", "bank_account"],
};
const REMOTE_INPUT = {
  type: "object",
  properties: {
    id: { type: "string" },
    workspace: { type: "string" },
  },
  required: ["id", "workspace"],
};

/** Steps below the hop that redact the bank account. */
const redact = (body: unknown) => {
  const { id, name } = body as typeof CONTACT;
  return { id, name };
};

/** A schema without one property, the shape a star route derives. */
function withoutProperty(
  schema: Readonly<Record<string, unknown>> | undefined,
  property: string,
): Record<string, unknown> | undefined {
  if (schema === undefined) return undefined;
  const properties = {
    ...(schema["properties"] as Record<string, unknown>),
  };
  delete properties[property];
  const required = (schema["required"] as string[] | undefined)?.filter(
    (name) => name !== property,
  );
  return { ...schema, properties, ...(required ? { required } : {}) };
}

/**
 * A proxy route advertises the schemas its steps produce: an exact route
 * its `.input()` and `.output()`, a star route what `schemas` derives from
 * the remote's. A route that redacts a field the remote requires no longer
 * fails every call with AI2001.
 */
describe("proxy routes advertise their own schemas", () => {
  let t: TestContext | undefined;
  let server: McpServer | undefined;
  let sent: Array<Record<string, unknown>> = [];

  afterEach(async () => {
    await server?.stop().catch(() => undefined);
    server = undefined;
    if (t) await t.stop();
    t = undefined;
    sent = [];
  });

  async function serve(routes: AnyRouteBuilder[]): Promise<McpServer> {
    const registry = new McpToolRegistry();
    registry.setToolsForSource("crm", "stdio", [
      {
        name: "get_contact",
        description: "Read one contact",
        inputSchema: REMOTE_INPUT as never,
        outputSchema: REMOTE_OUTPUT as never,
      },
    ]);
    const clients = new Map<string, McpClientConfig>([
      ["crm", { transport: "stdio", command: "crm-server" }],
    ]);
    const stdio = new Map([
      [
        "crm",
        {
          callTool: async () => CONTACT,
          callToolRaw: async (_name: string, args: Record<string, unknown>) => {
            sent.push(args);
            return {
              content: [{ type: "text", text: JSON.stringify(CONTACT) }],
              structuredContent: CONTACT,
            };
          },
        },
      ],
    ]);
    t = await testContext()
      .with({ plugins: [mcpPort({ tools: registry, clients, stdio })] })
      .routes(routes)
      .build();
    await t.startAndWaitReady();
    server = mcpServerFor(t.ctx);
    return server;
  }

  const Contact = z.object({ id: z.string(), name: z.string() });

  /**
   * @case An exact route with .output() redacts a field the remote's outputSchema requires, and the call succeeds
   * @preconditions Remote output requires bank_account; exact route with .output({ body: Contact }) and a transform after the hop that drops it
   * @expectedResult tools/list advertises the route's output (no bank_account); the call answers without isError and its structuredContent omits bank_account
   */
  test("an exact route's .output() is advertised and enforced", async () => {
    const srv = await serve([
      craft()
        .id("crm-get-contact")
        .output({ body: Contact })
        .from(mcp({ proxy: "crm:get_contact" }))
        .to(mcp("crm:get_contact"))
        .transform(redact) as AnyRouteBuilder,
    ]);
    const listed = srv
      .getAvailableTools()
      .find((tool) => tool.name === "crm_get_contact")!;
    expect(
      Object.keys(
        (listed.outputSchema as { properties: Record<string, unknown> })
          .properties,
      ).sort(),
    ).toEqual(["id", "name"]);

    const result = await callTool(srv, "crm_get_contact", {
      id: "c-1",
      workspace: "w",
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ id: "c-1", name: "Ada" });
  });

  /**
   * @case Without .output(), the redacted result is still advertised under the remote's schema
   * @preconditions The same exact route without .output()
   * @expectedResult tools/list still advertises the remote's output schema requiring bank_account, which the redacted structuredContent breaks, so a client that validates structured content rejects it
   */
  test("without .output() the remote's schema is still advertised", async () => {
    const srv = await serve([
      craft()
        .id("crm-get-contact")
        .from(mcp({ proxy: "crm:get_contact" }))
        .to(mcp("crm:get_contact"))
        .transform(redact) as AnyRouteBuilder,
    ]);
    const listed = srv
      .getAvailableTools()
      .find((tool) => tool.name === "crm_get_contact")!;
    expect((listed.outputSchema as { required: string[] }).required).toContain(
      "bank_account",
    );
  });

  /**
   * @case An exact route's narrower .input() is advertised, and a pinned argument is not asked of the caller
   * @preconditions .input({ body: { id } }) on an exact route whose step pins workspace before the hop
   * @expectedResult tools/list advertises id alone; a call with { id } reaches the remote with the pinned workspace; the agent catalogue reference carries the same input schema
   */
  test("an exact route's .input() is advertised (#912)", async () => {
    const Input = z.object({ id: z.string() });
    const srv = await serve([
      craft()
        .id("crm-get-contact")
        .input({ body: Input })
        .from(mcp({ proxy: "crm:get_contact" }))
        .transform((args) => ({ ...(args as object), workspace: "acme" }))
        .to(mcp("crm:get_contact")) as AnyRouteBuilder,
    ]);
    const listed = srv
      .getAvailableTools()
      .find((tool) => tool.name === "crm_get_contact")!;
    expect(
      Object.keys(
        (listed.inputSchema as { properties: Record<string, unknown> })
          .properties,
      ),
    ).toEqual(["id"]);

    const result = await callTool(srv, "crm_get_contact", { id: "c-1" });
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual([{ id: "c-1", workspace: "acme" }]);

    const [agentTool] = tools(["MCP(crm:get_contact)"]).resolve(t!.ctx);
    expect(agentTool!.input).toBe(Input);
  });

  /**
   * @case A star route derives each tool's output schema from the remote's, and redaction passes
   * @preconditions Star route with schemas: (remote) => ({ output: remote's without bank_account }) and a transform that drops it
   * @expectedResult tools/list advertises the derived schema; the call succeeds with structuredContent lacking bank_account
   */
  test("a star route's schemas derive the advertised output", async () => {
    const srv = await serve([
      craft()
        .id("crm")
        .from(
          mcp({
            proxy: "crm:*",
            schemas: (remote) => {
              const output = withoutProperty(
                remote.outputSchema,
                "bank_account",
              );
              return output === undefined ? {} : { output };
            },
          }),
        )
        .to(mcp("crm:*"))
        .transform(redact) as AnyRouteBuilder,
    ]);
    const listed = srv
      .getAvailableTools()
      .find((tool) => tool.name === "crm_get_contact")!;
    expect(
      (listed.outputSchema as { required: string[] }).required.sort(),
    ).toEqual(["id", "name"]);
    const result = await callTool(srv, "crm_get_contact", {
      id: "c-1",
      workspace: "w",
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ id: "c-1", name: "Ada" });
  });

  /**
   * @case output: null advertises no output schema
   * @preconditions Star route with schemas: () => ({ output: null })
   * @expectedResult tools/list carries no outputSchema for the tool
   */
  test("schemas output null drops the output schema", async () => {
    const srv = await serve([
      craft()
        .id("crm")
        .from(mcp({ proxy: "crm:*", schemas: () => ({ output: null }) }))
        .to(mcp("crm:*")) as AnyRouteBuilder,
    ]);
    const listed = srv
      .getAvailableTools()
      .find((tool) => tool.name === "crm_get_contact")!;
    expect(listed.outputSchema).toBeUndefined();
  });

  /**
   * @case A star route declaring .input() is refused at start
   * @preconditions Star route over crm with .input()
   * @expectedResult The route's source fails with RC5003 naming the exact form and schemas, so the route never serves
   */
  test("a star route with .input() is refused", async () => {
    t = await testContext()
      .with({
        plugins: [
          mcpPort({
            clients: new Map<string, McpClientConfig>([
              ["crm", { transport: "stdio", command: "crm-server" }],
            ]),
          }),
        ],
      })
      .routes([
        craft()
          .id("crm")
          .input({ body: z.object({ id: z.string() }) })
          .from(mcp({ proxy: "crm:*" }))
          .to(mcp("crm:*")) as AnyRouteBuilder,
      ])
      .build();
    const failures: unknown[] = [];
    t.ctx.on("route:source:failed", ({ details }) => {
      failures.push(details.error);
    });
    await t.ctx.start().catch(() => undefined);
    expect(String(failures[0])).toMatch(/declares \.input\(\) or \.output\(\)/);
  });

  /**
   * @case schemas is refused beside an exact proxy
   * @preconditions mcp({ proxy: "crm:get_contact", schemas })
   * @expectedResult mcp() throws RC5003 pointing at .input() and .output()
   */
  test("schemas beside an exact proxy is refused", () => {
    expect(() =>
      mcp({ proxy: "crm:get_contact", schemas: () => ({}) }),
    ).toThrow(/schemas cannot be set with the exact proxy/);
  });
});
