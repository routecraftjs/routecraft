/**
 * A capability reaching the person's editor while the turn is running.
 *
 * The framework provides the one way in and ships none of the routes that
 * use it, so every case here writes its own route the way an app would.
 * Each coded failure is provoked directly rather than asserted from a
 * read: a message that says the client disconnected is worth nothing
 * unless a disconnected client is what produced it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { DefaultExchange, craft, direct, noop } from "@routecraft/routecraft";
import { testContext } from "@routecraft/testing";
import { agentPlugin, surface, hasSurface, tools } from "../src/index.ts";
import { registerSurface } from "../src/surface/index.ts";
import { acpHarness, type AcpHarness } from "./helpers/acp-harness.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import {
  SURFACE_CONNECTION,
  SURFACED,
  scriptedSurface,
} from "./helpers/surface-stub.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

/**
 * The one worked route, written the way an app writes it: the framework
 * carries the seam and the guardrail is here, where a reader of this route
 * can see and change it.
 */
const readFileRoute = craft()
  .id("read-file")
  .description("Read a file through the person's editor")
  .input({ body: z.object({ path: z.string() }) })
  .from(direct())
  .enrich(surface("fs/read_text_file", (ex) => ({ path: ex.body.path })))
  .to(noop());

const AGENT = {
  max: {
    description: "Max",
    model: MODEL,
    system: "be useful",
    user: (ex: { body: unknown }) => (ex.body as { message: string }).message,
    tools: tools(["Direct(read-file)"]),
  },
};

describe("surface(), reaching the editor from a route", () => {
  let h: AcpHarness | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (h) await h.t.stop();
    h = undefined;
  });

  /**
   * @case A route asks the editor for a file mid-turn and the answer comes back
   * @preconditions A client advertising fs.readTextFile and answering the call, an agent calling the route as a tool
   * @expectedResult The editor is asked for the path the route named, with the running turn's session filled in, and the content it answered reaches the tool result
   */
  test("a round trip through the person's editor", async () => {
    const asked: Array<{ sessionId: string; path: string }> = [];
    h = await acpHarness({
      agents: AGENT,
      plugins: [agentPlugin({ functions: {} })],
      routes: [readFileRoute],
      handlers: (app) => {
        app.onRequest("fs/read_text_file", ({ params }) => {
          asked.push({ sessionId: params.sessionId, path: params.path });
          return { content: "the file's contents" };
        });
      },
    });
    llm.script.push(
      {
        toolCalls: [
          { toolName: "direct__read-file", input: { path: "/a.ts" } },
        ],
      },
      { text: "read it" },
    );

    const sessionId = await h.connect(
      (agent) =>
        agent.buildSession("/work").withSession(async (session) => {
          await session.prompt("read /a.ts");
          return session.sessionId;
        }),
      { capabilities: { fs: { readTextFile: true } } },
    );

    expect(asked).toEqual([{ sessionId, path: "/a.ts" }]);
    const results = h.seen
      .map((entry) => entry.update as Record<string, unknown>)
      .filter((update) => update["sessionUpdate"] === "tool_call_update");
    expect(results[0]).toMatchObject({
      status: "completed",
      rawOutput: { content: "the file's contents" },
    });
  });

  /**
   * @case A callback cannot name the session the call goes to
   * @preconditions A params callback returning the protocol's sessionId beside the path
   * @expectedResult It does not compile: the session is the running turn's, and a route that could name another would address another person's editor. The runtime call still fills the turn's session in, which the round-trip case above asserts on
   */
  test("sessionId is not a route's to supply", () => {
    // @ts-expect-error -- sessionId is the turn's, never the route's: the params type forbids it so a placeholder cannot be written
    const named = surface("fs/read_text_file", () => ({
      sessionId: "",
      path: "/a.ts",
    }));
    expect(named).toBeDefined();
  });

  /**
   * @case A route calling the editor with no editor attached fails naming that
   * @preconditions The same route, dispatched directly rather than from a turn
   * @expectedResult AI1013, and hasSurface() answers false, so a route can check first and take another path
   */
  test("no surface on the exchange is AI1013", async () => {
    const t = await testContext().routes([readFileRoute]).build();
    await t.startAndWaitReady();
    try {
      expect(
        hasSurface(new DefaultExchange(t.ctx, { body: { path: "/a.ts" } })),
      ).toBe(false);
      await expect(
        t.client.sendDirect("read-file", { path: "/a.ts" }),
      ).rejects.toMatchObject({ rc: "AI1013" });
    } finally {
      await t.stop();
    }
  });

  /**
   * @case A turn whose editor went away mid-flight is told so, rather than told there never was one
   * @preconditions An exchange carrying a surface header naming a connection the registry does not hold
   * @expectedResult AI1014, distinct from AI1013, because the fix is different: there is nothing to retry against on this exchange
   */
  test("a surface that disconnected is AI1014", async () => {
    const t = await testContext().routes([readFileRoute]).build();
    await t.startAndWaitReady();
    try {
      // Reachable first: with the connection registered, the call goes out.
      const answered = { asked: 0 };
      const retire = registerSurface(
        t.ctx,
        SURFACE_CONNECTION,
        scriptedSurface({
          request: async () => {
            answered.asked += 1;
            return { content: "here" };
          },
        }),
      );
      await t.client.sendDirect("read-file", { path: "/a.ts" }, SURFACED);
      expect(answered.asked).toBe(1);

      // Then the same exchange shape with the connection gone.
      retire();
      await expect(
        t.client.sendDirect("read-file", { path: "/a.ts" }, SURFACED),
      ).rejects.toMatchObject({ rc: "AI1014" });
    } finally {
      await t.stop();
    }
  });

  /**
   * @case A capability the client never advertised is a configuration mismatch, named as one
   * @preconditions A live surface that reports the method unsupported
   * @expectedResult AI1015 naming the capability, and the call is never sent, so the client is not left to answer something it does not serve
   */
  test("a capability the client never offered is AI1015", async () => {
    const t = await testContext().routes([readFileRoute]).build();
    await t.startAndWaitReady();
    try {
      let sent = 0;
      registerSurface(
        t.ctx,
        SURFACE_CONNECTION,
        scriptedSurface({
          supports: () => false,
          request: async () => {
            sent += 1;
            return {};
          },
        }),
      );
      await expect(
        t.client.sendDirect("read-file", { path: "/a.ts" }, SURFACED),
      ).rejects.toMatchObject({ rc: "AI1015" });
      expect(sent).toBe(0);
    } finally {
      await t.stop();
    }
  });

  /**
   * @case A person declining reaches the route as a handled outcome
   * @preconditions A live surface that answers the call with an error
   * @expectedResult AI1016 carrying the client's own message as its cause, which is what a route branches on with .error()
   */
  test("a client that refuses is AI1016", async () => {
    const t = await testContext().routes([readFileRoute]).build();
    await t.startAndWaitReady();
    try {
      registerSurface(
        t.ctx,
        SURFACE_CONNECTION,
        scriptedSurface({
          request: () => Promise.reject(new Error("the person said no")),
        }),
      );
      await expect(
        t.client.sendDirect("read-file", { path: "/a.ts" }, SURFACED),
      ).rejects.toMatchObject({ rc: "AI1016" });
    } finally {
      await t.stop();
    }
  });

  /**
   * @case A route can ask whether there is an editor before reaching for one
   * @preconditions One exchange carrying a live surface and one carrying none
   * @expectedResult hasSurface answers true and false, so the same route can serve an editor and a schedule without an error path between them
   */
  test("hasSurface is the guard a route branches on", async () => {
    const t = await testContext().routes([readFileRoute]).build();
    await t.startAndWaitReady();
    try {
      registerSurface(
        t.ctx,
        SURFACE_CONNECTION,
        scriptedSurface({ request: async () => ({}) }),
      );
      expect(
        hasSurface(new DefaultExchange(t.ctx, { body: {}, headers: SURFACED })),
      ).toBe(true);
      expect(hasSurface(new DefaultExchange(t.ctx, { body: {} }))).toBe(false);
    } finally {
      await t.stop();
    }
  });
});
