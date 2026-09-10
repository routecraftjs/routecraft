import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { craft, direct, jwt, noop, opsPlugin } from "@routecraft/routecraft";
import {
  signHs256,
  spy,
  testContext,
  type TestContext,
} from "@routecraft/testing";
import {
  agent,
  agentPlugin,
  directTool,
  llmPlugin,
  tools,
  type AgentResult,
} from "../src/index.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

/**
 * Imported routes on the agent tool surface.
 *
 * A second instance exposes two routes through a scope-gated ops door;
 * the first imports it as `default` and as `lab`, and an agent on the
 * first names them the three ways the grammar allows. The scripted model
 * really calls the tools, so the second instance's answer is what the
 * agent returns.
 */

const JWT_SECRET = "remote-tools-jwt-secret-please-change-me";
/** Minted per request so the suite never depends on finishing inside a token's minute. */
const operator = (): string =>
  signHs256({
    secret: JWT_SECRET,
    claims: { scope: "ops:introspection ops:dispatch" },
  });

async function startServer(): Promise<{ t: TestContext; url: string }> {
  const t = await testContext()
    .with({
      servers: { default: { port: 0, host: "127.0.0.1" } },
      plugins: [
        opsPlugin({
          auth: jwt({
            secret: JWT_SECRET,
            issuer: "https://idp.test",
            audience: "https://api.test",
          }),
          tiers: {
            introspection: "ops:introspection",
            dispatch: "ops:dispatch",
          },
        }),
      ],
    })
    .routes([
      craft()
        .id("hello")
        .description("Say hello to someone")
        .input({ body: z.object({ name: z.string() }) })
        .from(direct())
        .transform((body) => ({ greeting: `hello ${body.name}` }))
        .to(noop()),
      craft()
        .id("memory:get")
        .description("A route whose id is not a tool name")
        .input({ body: z.object({ key: z.string() }) })
        .from(direct())
        .transform((body) => ({ value: body.key }))
        .to(noop()),
    ])
    .build();
  let port: number | undefined;
  t.ctx.on("server:listening", ({ details }) => {
    port = details.port;
  });
  await t.startAndWaitReady();
  if (port === undefined) throw new Error("no server reported a port");
  return { t, url: `http://127.0.0.1:${String(port)}` };
}

describe("tools() with imported routes", () => {
  let server: { t: TestContext; url: string } | undefined;
  let local: TestContext | undefined;

  afterEach(async () => {
    llm.reset();
    if (local) await local.stop();
    if (server) await server.t.stop();
    local = undefined;
    server = undefined;
  });

  /**
   * @case Direct(hello), Direct(lab:hello) and Remote(lab) resolve to tools whose provenance names the remote
   * @preconditions Both remotes imported; an agentPlugin with a directTool alias of `lab:hello`
   * @expectedResult The bare default route keeps the `direct__hello` wire name; the qualified reference and every Remote(lab) expansion carry `remote__lab__<id>`; every source is `direct` with `remote` set, the alias included; the remote route whose id is not a tool name is dropped from the expansion with a warning and refused by name when referenced explicitly. A colon is outside the provider charset, and the remote's name takes the MCP client's place as the constrained half
   */
  test("resolves the three reference forms and marks their provenance", async () => {
    server = await startServer();
    const { url } = server;
    local = await testContext()
      .with({
        remotes: {
          default: { url, auth: { token: operator } },
          lab: { url, auth: { token: operator } },
        },
        plugins: [
          agentPlugin({ functions: { labHello: directTool("lab:hello") } }),
        ],
      })
      .routes([craft().id("keepalive").from(direct()).to(noop())])
      .build();
    const warnings: string[] = [];
    const original = local.ctx.logger.warn.bind(local.ctx.logger);
    local.ctx.logger.warn = ((first: unknown, second?: unknown) => {
      warnings.push(typeof first === "string" ? first : String(second));
      return original(first as never, second as never);
    }) as typeof local.ctx.logger.warn;
    await local.startAndWaitReady();

    const resolved = tools([
      "Direct(hello)",
      "Direct(lab:hello)",
      "Remote(lab)",
      "labHello",
    ]).resolve(local.ctx);
    const byName = new Map(resolved.map((tool) => [tool.name, tool]));
    expect([...byName.keys()].sort()).toEqual([
      "direct__hello",
      "labHello",
      "remote__lab__hello",
    ]);
    expect(byName.get("direct__hello")?.source).toEqual({
      kind: "direct",
      routeId: "hello",
      remote: "default",
    });
    expect(byName.get("remote__lab__hello")?.source).toEqual({
      kind: "direct",
      routeId: "lab:hello",
      remote: "lab",
    });
    expect(byName.get("labHello")?.source).toEqual({
      kind: "direct",
      routeId: "lab:hello",
      remote: "lab",
    });
    expect(byName.get("remote__lab__hello")?.description).toBe(
      "Say hello to someone",
    );
    expect(
      warnings.filter((line) =>
        line.includes("Remote route id is not usable as a provider tool name"),
      ),
    ).toHaveLength(1);
    expect(() => tools(["Direct(lab:memory:get)"]).resolve(local!.ctx)).toThrow(
      /remote__lab__memory:get/,
    );
    expect(() => tools(["Remote(nowhere)"]).resolve(local!.ctx)).toThrow(
      /Remotes with routes: "default", "lab"/,
    );
  });

  /**
   * @case An agent calls an imported route and gets the second instance's answer, and a local-only policy withholds it
   * @preconditions A scripted model that calls `remote__lab__hello`; one context with no policy, one whose `direct` rule admits only local capabilities
   * @expectedResult Without a policy the tool call's output is the remote's greeting; with the local-only rule the tool is dropped and the model is never offered it. `source.remote` is what makes the rule expressible
   */
  test("dispatches an imported route from an agent and lets a policy keep an agent local-only", async () => {
    server = await startServer();
    const { url } = server;
    const run = async (localOnly: boolean): Promise<AgentResult> => {
      const sink = spy();
      const t = await testContext()
        .with({
          remotes: { lab: { url, auth: { token: operator } } },
          plugins: [
            llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
            agentPlugin(
              localOnly
                ? {
                    toolPolicy: {
                      fn: true,
                      direct: (tool) => tool.source.remote === undefined,
                      mcp: false,
                    },
                  }
                : {},
            ),
          ],
        })
        .routes([
          craft()
            .id("ask")
            .from(direct())
            .to(
              agent({
                system: "be useful",
                model: MODEL,
                tools: tools(["Remote(lab)"]),
              }),
            )
            .to(sink),
        ])
        .build();
      local = t;
      await t.startAndWaitReady();
      llm.script.push(
        {
          toolCalls: [
            { toolName: "remote__lab__hello", input: { name: "agent" } },
          ],
        },
        { text: "done" },
      );
      await t.client.sendDirect("ask", "hi");
      const result = sink.received[0]!.body as AgentResult;
      await t.stop();
      local = undefined;
      return result;
    };

    const open = await run(false);
    expect(open.toolCalls).toHaveLength(1);
    expect(open.toolCalls![0]).toMatchObject({
      toolName: "remote__lab__hello",
      output: { greeting: "hello agent" },
    });

    llm.reset();
    const closed = await run(true);
    // The scripted model still asks for the tool; the agent was never offered
    // it, so the call fails instead of reaching the remote.
    const denied = closed.toolCalls ?? [];
    expect(denied).toHaveLength(1);
    expect(denied[0]!.output).toBeUndefined();
    expect(denied[0]!.error).toBeInstanceOf(Error);
  });

  /**
   * @case A shadowing local route that stops makes `Direct(hello)` a remote-backed tool, and a local-only rule then withholds it
   * @preconditions A local `hello` shadowing the default remote's `hello`; `Direct(hello)` resolved before and after the local route stops
   * @expectedResult Before the stop the tool's source carries no `remote` and is admitted by the local-only rule. After the stop the same reference resolves with `remote: "default"`, the rule drops it, and a call through the tool that is admitted reaches the remote. A tool must never be labelled local while its dispatch leaves the instance
   */
  test("relabels Direct(hello) as remote-backed once the shadowing local route stops", async () => {
    server = await startServer();
    const { url } = server;
    local = await testContext()
      .with({
        remotes: { default: { url, auth: { token: operator } } },
        plugins: [agentPlugin()],
      })
      .routes([
        craft()
          .id("hello")
          .description("The local greeter")
          .input({ body: z.object({ name: z.string() }) })
          .from(direct())
          .transform(() => ({ greeting: "local" }))
          .to(noop()),
        craft().id("keepalive").from(direct()).to(noop()),
      ])
      .build();
    await local.startAndWaitReady();
    const resolveHello = () => tools(["Direct(hello)"]).resolve(local!.ctx)[0]!;
    const localOnly = (tool: ReturnType<typeof resolveHello>): boolean =>
      tool.source.kind === "direct" && tool.source.remote === undefined;

    const before = resolveHello();
    expect(before.source).toEqual({ kind: "direct", routeId: "hello" });
    expect(localOnly(before)).toBe(true);

    const route = local.ctx
      .getRoutes()
      .find((candidate) => candidate.definition.id === "hello");
    if (route === undefined) throw new Error("the local route is missing");
    route.stop();
    const deadline = Date.now() + 5_000;
    while (
      local.ctx.capabilities().find((c) => c.endpoint === "hello")?.remote !==
      "default"
    ) {
      if (Date.now() > deadline) throw new Error("the shadow never lifted");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const after = resolveHello();
    expect(after.name).toBe("direct__hello");
    expect(after.source).toEqual({
      kind: "direct",
      routeId: "hello",
      remote: "default",
    });
    expect(localOnly(after)).toBe(false);
    const answer: unknown = await local.client.sendDirect("hello", {
      name: "agent",
    });
    expect(answer).toEqual({ greeting: "hello agent" });
  });
});
