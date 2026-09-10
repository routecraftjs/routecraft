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
import { RequestError } from "@agentclientprotocol/sdk";
import {
  DefaultExchange,
  HeadersKeys,
  craft,
  direct,
  noop,
  rcCodeOf,
  type Exchange,
} from "@routecraft/routecraft";
import { asDeferred, deferring, testContext } from "@routecraft/testing";
import { agentPlugin, surface, hasSurface, tools } from "../src/index.ts";
import {
  SurfaceDisconnected,
  registerSurface,
  registerTurn,
  type SurfaceRequestParams,
} from "../src/surface/index.ts";
import { acpHarness, type AcpHarness } from "./helpers/acp-harness.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { slowTool } from "./helpers/slow-tool.ts";
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

/**
 * A command in the person's terminal, written the way the harness writes
 * it: create, register the cleanup a cancel would need, wait, and release
 * on the way out. `discharge` says whether the route withdraws its own
 * registration once the wait has answered, or leaves that to the exchange
 * completing.
 */
const runCommandRoute = craft()
  .id("run-command")
  .description("Run a command in the person's terminal")
  .input({ body: z.object({ discharge: z.boolean().optional() }) })
  .from(direct())
  .transform(async (body, exchange) => {
    const created = await surface("terminal/create", {
      command: "sleep",
      args: ["30"],
    }).fetch(exchange as Exchange<unknown>);
    const terminalId = created.terminalId;
    const withdraw = surface.onCancel(exchange as Exchange<unknown>, [
      { method: "terminal/kill", params: { terminalId } },
      { method: "terminal/release", params: { terminalId } },
    ]);
    try {
      await surface("terminal/wait_for_exit", { terminalId }).fetch(
        exchange as Exchange<unknown>,
      );
    } catch (error: unknown) {
      // What the harness does on its way out, and what the contract says
      // happens to it: refused here, never sent.
      await Promise.resolve(
        surface("terminal/output", { terminalId }).fetch(
          exchange as Exchange<unknown>,
        ),
      ).catch(() => undefined);
      throw error;
    }
    if (body.discharge === true) withdraw();
    return { terminalId };
  });

const AGENT = {
  max: {
    description: "Max",
    model: MODEL,
    system: "be useful",
    user: (ex: { body: unknown }) => (ex.body as { message: string }).message,
    tools: tools(["Direct(read-file)"]),
  },
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a condition, bounded, so a failure reports as an assertion. */
async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await sleep(1);
  expect(condition()).toBe(true);
}

/**
 * An editor with a terminal, recording every call in the order it arrived.
 * The command exits at once when `exits` is set; otherwise the wait is
 * answered only when the instance cancels it, as a command that never
 * exits on its own would be.
 */
function terminalEditor(
  calls: string[],
  options: { exits?: boolean; onRelease?: () => void } = {},
): (
  app: Parameters<NonNullable<Parameters<typeof acpHarness>[0]["handlers"]>>[0],
) => void {
  return (app) => {
    app.onRequest("terminal/create", () => {
      calls.push("terminal/create");
      return { terminalId: "t-1" };
    });
    app.onRequest("terminal/wait_for_exit", ({ signal }) => {
      calls.push("terminal/wait_for_exit");
      if (options.exits === true) return { exitCode: 0 };
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(RequestError.requestCancelled()),
          { once: true },
        );
      });
    });
    app.onRequest("terminal/kill", () => {
      calls.push("terminal/kill");
      return {};
    });
    app.onRequest("terminal/release", () => {
      calls.push("terminal/release");
      options.onRelease?.();
      return {};
    });
    app.onRequest("terminal/output", () => {
      calls.push("terminal/output");
      return { output: "", truncated: false };
    });
  };
}

describe("surface(), reaching the editor from a route", () => {
  let h: AcpHarness | undefined;
  const slow = slowTool();

  beforeEach(() => {
    llm.reset();
    slow.reset();
  });

  afterEach(async () => {
    slow.release();
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
   * @case A method whose params are a union keeps every arm after the session is removed
   * @preconditions elicitation/create, which the SDK types as form | url, each arm with its own fields
   * @expectedResult A literal written against the params type compiles for either arm with no cast. The removal distributes over the union rather than collapsing it to the keys the arms share, which is what made url and requestedSchema excess properties before. Written as typed assignments rather than callback returns, because a callback's inferred return is never excess-property checked and so could not have caught the collapse
   */
  test("a union-shaped request keeps its arms", () => {
    const url: SurfaceRequestParams["elicitation/create"] = {
      mode: "url",
      elicitationId: "e-1",
      url: "https://example.test/approve",
      message: "Approve the deployment",
    };
    const form: SurfaceRequestParams["elicitation/create"] = {
      mode: "form",
      requestedSchema: { type: "object", properties: {} },
      message: "Name the release",
    };
    expect(surface("elicitation/create", url)).toBeDefined();
    expect(surface("elicitation/create", form)).toBeDefined();
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
   * @case A surface that drops while the call is outstanding is a disconnect, not a refusal
   * @preconditions A live surface whose request rejects the way a backend reports its transport gone
   * @expectedResult AI1014 rather than AI1016, because the fixes differ: nothing to retry against, where a refusal is a person's answer to handle
   */
  test("a drop while the call is outstanding is AI1014", async () => {
    const t = await testContext().routes([readFileRoute]).build();
    await t.startAndWaitReady();
    try {
      registerSurface(
        t.ctx,
        SURFACE_CONNECTION,
        scriptedSurface({
          request: () =>
            Promise.reject(
              new SurfaceDisconnected(new Error("ACP connection closed")),
            ),
        }),
      );
      await expect(
        t.client.sendDirect("read-file", { path: "/a.ts" }, SURFACED),
      ).rejects.toMatchObject({ rc: "AI1014" });
    } finally {
      await t.stop();
    }
  });

  /**
   * @case An editor that goes away while a call is outstanding settles the route once, as a disconnect
   * @preconditions A real editor that never answers the file read, closing its connection once the instance has asked
   * @expectedResult The route fails exactly once with AI1014 and the exchange ends; nothing waits for the editor to come back, since a reconnected editor is a new surface and the call is never re-sent
   */
  test("an editor leaving mid-call settles the route as AI1014, once", async () => {
    let asked = false;
    const failures: unknown[] = [];
    h = await acpHarness({
      agents: AGENT,
      plugins: [agentPlugin({ functions: {} })],
      routes: [readFileRoute],
      handlers: (app) => {
        app.onRequest("fs/read_text_file", () => {
          asked = true;
          return new Promise<never>(() => undefined);
        });
      },
    });
    h.t.ctx.on("route:exchange:failed", ({ details }) => {
      if (details.routeId === "read-file") failures.push(details.error);
    });
    llm.script.push(
      {
        toolCalls: [
          { toolName: "direct__read-file", input: { path: "/a.ts" } },
        ],
      },
      { text: "the editor left" },
    );

    await h.connect(
      async (agent) => {
        const session = await agent.buildSession("/work").start();
        agent
          .request("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "read /a.ts" }],
          })
          .catch(() => undefined);
        await until(() => asked);
        session.dispose();
      },
      { capabilities: { fs: { readTextFile: true } } },
    );

    await until(() => failures.length >= 1);
    await sleep(50);
    expect(failures).toHaveLength(1);
    expect(rcCodeOf(failures[0])).toBe("AI1014");
  });

  /**
   * @case A turn revived from a stored record after a restart has no editor, and a call from it says so
   * @preconditions A route that defers before reaching the editor, deferred with a live surface on its exchange; the surface then retired, as a restart leaves every connection; the deferral resumed from the store
   * @expectedResult The continuation fails with AI1014. The surface reference survives in the stored exchange, the connection it names does not, and nothing re-sends or waits for an editor to come back: what was outstanding at the restart died with the process
   */
  test("a revived turn has no editor, and is told so", async () => {
    const t = await testContext()
      .with(deferring())
      .routes([
        craft()
          .id("deferred-read")
          .from(direct())
          .defer({ schema: z.object({}) })
          .enrich(surface("fs/read_text_file", { path: "/a.ts" }))
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();
    try {
      const retire = registerSurface(
        t.ctx,
        SURFACE_CONNECTION,
        scriptedSurface({ request: async () => ({ content: "here" }) }),
      );
      const deferred = asDeferred(
        await t.client.sendDirect("deferred-read", {}, SURFACED),
      );
      retire();

      const acknowledgment = (await t.client.sendDirect("answers", {
        token: deferred.token,
        result: {},
      })) as {
        status: string;
        continuation: { status: string; error?: { rc?: string } };
      };

      expect(acknowledgment.status).toBe("resumed");
      expect(acknowledgment.continuation.status).toBe("failed");
      expect(acknowledgment.continuation.error?.rc).toBe("AI1014");
    } finally {
      await t.stop();
    }
  });

  /**
   * @case A route keeps the surface it resolved after the mount has forgotten its turn
   * @preconditions An exchange carrying only a correlation id, resolved once while the turn table names its surface, then again after the table entry is gone
   * @expectedResult The second call reaches the same surface. The routes a turn called are still running when the mount forgets the turn, and a route that had a surface is never told it did not
   */
  test("a resolved surface stays the exchange's for its life", async () => {
    const t = await testContext().routes([]).build();
    await t.startAndWaitReady();
    try {
      let asked = 0;
      registerSurface(
        t.ctx,
        SURFACE_CONNECTION,
        scriptedSurface({
          request: async () => {
            asked += 1;
            return { content: "here" };
          },
        }),
      );
      const forget = registerTurn(t.ctx, "turn-1", {
        kind: "acp",
        session: "s",
        connection: SURFACE_CONNECTION,
      });
      const exchange = new DefaultExchange(t.ctx, {
        body: {},
        headers: { [HeadersKeys.CORRELATION_ID]: "turn-1" },
      });
      const read = surface("fs/read_text_file", { path: "/a.ts" });
      await read.fetch(exchange);
      forget();
      await read.fetch(exchange);
      expect(asked).toBe(2);
      expect(hasSurface(exchange)).toBe(true);
    } finally {
      await t.stop();
    }
  });

  /**
   * @case Cancelling a turn cancels the call a route has outstanding, sends the cleanup it registered, and refuses what it asks for afterwards
   * @preconditions A route that creates a terminal, registers kill and release against a cancel, and waits for the command to exit; an editor that answers the wait only when it is cancelled; the person cancelling while the wait is outstanding
   * @expectedResult The prompt returns cancelled. The editor sees the wait cancelled and then the kill and the release, in that order, sent by the framework; the output read the route attempts on its way out is refused with AI1016 and never reaches the editor
   */
  test("a cancelled turn sends the cleanup a route registered, and nothing else", async () => {
    const calls: string[] = [];
    const failures: unknown[] = [];
    let released!: () => void;
    const releaseSeen = new Promise<void>((resolve) => {
      released = resolve;
    });
    h = await acpHarness({
      agents: {
        max: { ...AGENT.max, tools: tools(["Direct(run-command)"]) },
      },
      plugins: [agentPlugin({ functions: {} })],
      routes: [runCommandRoute],
      handlers: terminalEditor(calls, { onRelease: () => released() }),
    });
    h.t.ctx.on("route:exchange:failed", ({ details }) => {
      if (details.routeId === "run-command") failures.push(details.error);
    });
    llm.script.push(
      { toolCalls: [{ toolName: "direct__run-command", input: {} }] },
      { text: "stopped" },
    );

    const stopReason = await h.connect(
      async (agent) => {
        const session = await agent.buildSession("/work").start();
        const running = agent.request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "run it" }],
        });
        await until(() => calls.includes("terminal/wait_for_exit"));
        await agent.notify("session/cancel", { sessionId: session.sessionId });
        const response = await running;
        await releaseSeen;
        session.dispose();
        return response.stopReason;
      },
      { capabilities: { terminal: true } },
    );

    expect(stopReason).toBe("cancelled");
    expect(calls).toEqual([
      "terminal/create",
      "terminal/wait_for_exit",
      "terminal/kill",
      "terminal/release",
    ]);
    await until(() => failures.length === 1);
    expect(rcCodeOf(failures[0])).toBe("AI1016");
  });

  /**
   * @case Cleanup a route withdrew, or that outlived its exchange, does not run at a later cancel
   * @preconditions The same route finishing normally, once withdrawing its registration and once leaving it to the exchange completing, then the turn cancelled during a later hand
   * @expectedResult Neither run sends the kill or the release: a cancel later in the conversation cannot replay a cleanup for a terminal the route already finished with
   */
  test("cleanup dies with its exchange, withdrawn or not", async () => {
    for (const discharge of [true, false]) {
      const calls: string[] = [];
      h = await acpHarness({
        agents: {
          max: {
            ...AGENT.max,
            tools: tools(["Direct(run-command)", "slow"]),
          },
        },
        plugins: [agentPlugin({ functions: { slow: slow.fn } })],
        routes: [runCommandRoute],
        handlers: terminalEditor(calls, { exits: true }),
      });
      llm.reset();
      slow.reset();
      llm.script.push(
        {
          toolCalls: [
            { toolName: "direct__run-command", input: { discharge } },
          ],
        },
        { toolCalls: [{ toolName: "slow", input: {} }] },
        { text: "stopped" },
      );

      const stopReason = await h.connect(
        async (agent) => {
          const session = await agent.buildSession("/work").start();
          const running = agent.request("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "run it" }],
          });
          await slow.waitForEntry(1);
          await agent.notify("session/cancel", {
            sessionId: session.sessionId,
          });
          const response = await running;
          await sleep(100);
          session.dispose();
          return response.stopReason;
        },
        { capabilities: { terminal: true } },
      );

      expect(stopReason).toBe("cancelled");
      expect(calls).toEqual(["terminal/create", "terminal/wait_for_exit"]);
      await h.t.stop();
      h = undefined;
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
