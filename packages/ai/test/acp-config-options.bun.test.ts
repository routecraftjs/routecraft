/**
 * Changing the persona, the model and the thinking level from an editor.
 *
 * The protocol has no rejected-with-a-reason response for a set, so a
 * refusal is the complete unchanged list and the only way a client can
 * tell what happened is by comparing. Six cases, four of them refusals of
 * that shape and two of them genuine errors.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { agentPlugin, tools, type FnHandlerContext } from "../src/index.ts";
import { acpHarness, type AcpHarness } from "./helpers/acp-harness.ts";
import {
  AgentSessionRuntime,
  MemorySessionStore,
  type SessionCasResult,
  type SessionStore,
  type StoredSession,
} from "../src/agent/session/index.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const SONNET = "anthropic:claude-sonnet-4-6";
const OPUS = "anthropic:claude-opus-4-7";
const HAIKU = "anthropic:claude-haiku-4-5";

/** A tool the test holds open, so a turn can be caught mid-flight. */
let release: (() => void) | undefined;
let entered = 0;
const slowFn = {
  description: "Waits until the test releases it",
  input: z.object({}),
  handler: (_input: unknown, ctx: FnHandlerContext) =>
    new Promise<string>((resolve, reject) => {
      entered += 1;
      const abort = (): void => {
        const err = new Error("slow tool aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (ctx.abortSignal.aborted) return abort();
      ctx.abortSignal.addEventListener("abort", abort, { once: true });
      release = () => resolve("released");
    }),
};

const CHOOSY = {
  max: {
    description: "Max",
    model: SONNET,
    models: [SONNET, OPUS],
    reasoning: "medium" as const,
    reasoningLevels: ["medium", "high"] as const,
    system: "be useful",
    user: (ex: { body: unknown }) => (ex.body as { message: string }).message,
    tools: tools(["slow"]),
  },
  zoe: {
    description: "Zoe",
    // A different model from max's, so which persona answered a turn is
    // readable from the call the provider saw.
    model: HAIKU,
    system: "be useful",
    user: (ex: { body: unknown }) => (ex.body as { message: string }).message,
  },
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEntry(count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (entered < count && Date.now() < deadline) await sleep(5);
  if (entered < count) throw new Error(`slow tool entry ${count} never came`);
}

/** The value of one option in a set response. */
function valueOf(
  options: Array<{ id: string; type?: string; currentValue?: unknown }>,
  id: string,
): unknown {
  return options.find((option) => option.id === id)?.currentValue;
}

/**
 * A store whose writes can be made to never land, which is a store fault
 * rather than a lost race: the compare-and-swap gives up and reports it.
 */
class StallingStore implements SessionStore {
  readonly inner = new MemorySessionStore();
  failWrites = false;

  get(key: string): Promise<StoredSession | undefined> {
    return this.inner.get(key);
  }
  create(key: string, value: unknown): Promise<SessionCasResult> {
    return this.inner.create(key, value);
  }
  async replace(
    key: string,
    version: number,
    value: unknown,
  ): Promise<SessionCasResult> {
    if (this.failWrites) return { won: false };
    return this.inner.replace(key, version, value);
  }
  keys(): Promise<string[]> {
    return this.inner.keys();
  }
  remove(key: string): Promise<void> {
    return this.inner.remove(key);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

/** The modes an old-API response offers, for the list that collapses. */
function modeIdsOf(response: {
  modes?: { availableModes: Array<{ id: string }> } | null;
}): string[] {
  return (response.modes?.availableModes ?? []).map((mode) => mode.id);
}

/** Which controls a response carries at all, for the ones that are withdrawn. */
function idsOf(options: Array<{ id: string }>): string[] {
  return options.map((option) => option.id);
}

describe("session config options", () => {
  let h: AcpHarness | undefined;

  beforeEach(() => {
    llm.reset();
    release = undefined;
    entered = 0;
  });

  afterEach(async () => {
    release?.();
    if (h) await h.t.stop();
    h = undefined;
  });

  async function boot(): Promise<AcpHarness> {
    return acpHarness({
      agents: CHOOSY,
      acp: { agent: "max" },
      plugins: [agentPlugin({ functions: { slow: slowFn } })],
    });
  }

  /** The persona the record names, which is the only place it lives. */
  async function personaOf(sessionId: string): Promise<string | undefined> {
    return (await AgentSessionRuntime.for(h!.t.ctx).store.load(sessionId))
      ?.agent;
  }

  /**
   * @case An advertised change is accepted, notified, and reaches the next turn
   * @preconditions A session on an agent offering two models, set to the second one
   * @expectedResult The response carries the new current value, a config_option_update carries the same list, and the turn after it runs on the model that was picked
   */
  test("an advertised change applies at the next turn", async () => {
    h = await boot();
    llm.script.push({ text: "one" });

    await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => {
        const set = await agent.request("session/set_config_option", {
          sessionId: session.sessionId,
          configId: "model",
          value: OPUS,
        });
        expect(valueOf(set.configOptions, "model")).toBe(OPUS);
        await session.prompt("go");
      }),
    );

    expect(llm.calls[0]?.modelId).toBe("claude-opus-4-7");
    const notified = h.seen.filter(
      (entry) =>
        (entry.update as { sessionUpdate: string }).sessionUpdate ===
        "config_option_update",
    );
    expect(notified).toHaveLength(1);
    expect(
      valueOf(
        (
          notified[0]!.update as {
            configOptions: Array<{ id: string; currentValue?: unknown }>;
          }
        ).configOptions,
        "model",
      ),
    ).toBe(OPUS);
  });

  /**
   * @case A value the agent does not offer is refused with the unchanged list
   * @preconditions A session on an agent offering two models, set to a third
   * @expectedResult The response is the complete list with the original current value, no config_option_update is sent, and the turn still runs on the default
   */
  test("a value outside the advertised list is refused", async () => {
    h = await boot();
    llm.script.push({ text: "one" });

    await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => {
        const set = await agent.request("session/set_config_option", {
          sessionId: session.sessionId,
          configId: "model",
          value: HAIKU,
        });
        expect(valueOf(set.configOptions, "model")).toBe(SONNET);
        await session.prompt("go");
      }),
    );

    expect(llm.calls[0]?.modelId).toBe("claude-sonnet-4-6");
    expect(
      h.seen.filter(
        (entry) =>
          (entry.update as { sessionUpdate: string }).sessionUpdate ===
          "config_option_update",
      ),
    ).toHaveLength(0);
  });

  /**
   * @case A known id the session does not advertise is refused rather than errored
   * @preconditions A session on the agent that offers no thinking levels, set on the thinking level
   * @expectedResult The complete unchanged list comes back with no thinking option in it, because the id is one this mount knows and this session simply does not offer
   */
  test("a known id the session does not advertise is refused", async () => {
    h = await acpHarness({
      agents: { zoe: CHOOSY.zoe },
    });
    const set = await h.connect((agent) =>
      agent.buildSession("/work").withSession((session) =>
        agent.request("session/set_config_option", {
          sessionId: session.sessionId,
          configId: "reasoning",
          value: "high",
        }),
      ),
    );
    expect(set.configOptions.map((o) => o.id)).toEqual([]);
  });

  /**
   * @case An unknown option id is a genuine error
   * @preconditions A session, set on an id this mount does not serve
   * @expectedResult The call fails rather than returning a list, because a list would be a lie: there is nothing to report the current value of
   */
  test("an unknown option id errors", async () => {
    h = await boot();
    await expect(
      h.connect((agent) =>
        agent.buildSession("/work").withSession((session) =>
          agent.request("session/set_config_option", {
            sessionId: session.sessionId,
            configId: "temperature",
            value: "hot",
          }),
        ),
      ),
    ).rejects.toThrow(/No configuration option/);
  });

  /**
   * @case A session that does not exist errors, in the words a foreign one gets
   * @preconditions A set against an id nobody ever issued
   * @expectedResult The refusal names no such session, which is the same answer a session belonging to somebody else gets
   */
  test("a missing session errors", async () => {
    h = await boot();
    await expect(
      h.connect((agent) =>
        agent.request("session/set_config_option", {
          sessionId: "11111111-2222-3333-4444-555555555555",
          configId: "model",
          value: OPUS,
        }),
      ),
    ).rejects.toThrow(/No such session/);
  });

  /**
   * @case The persona can be changed before the first turn, and the control is gone after it
   * @preconditions One session, the persona changed before any prompt and again after one
   * @expectedResult The first change is accepted. The second answers a list with no persona control at all, because a control that cannot do anything is not advertised, and the record still names the persona that answered
   */
  test("the persona is fixed once the conversation has started", async () => {
    h = await boot();
    llm.script.push({ text: "one" });

    await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => {
        const early = await agent.request("session/set_config_option", {
          sessionId: session.sessionId,
          configId: "agent",
          value: "zoe",
        });
        expect(valueOf(early.configOptions, "agent")).toBe("zoe");

        await session.prompt("go");

        const late = await agent.request("session/set_config_option", {
          sessionId: session.sessionId,
          configId: "agent",
          value: "max",
        });
        expect(idsOf(late.configOptions)).not.toContain("agent");
        expect(await personaOf(session.sessionId)).toBe("zoe");
      }),
    );
  });

  /**
   * @case The persona cannot be changed while a turn is running
   * @preconditions A turn held open inside a tool, with a persona change attempted mid-flight
   * @expectedResult The persona control is not advertised while a turn is running, and the record still names the persona whose tools that turn is inside
   */
  test("the persona cannot be changed mid-turn", async () => {
    h = await boot();
    llm.script.push({ toolCalls: [{ toolName: "slow" }] }, { text: "done" });

    await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => {
        const running = session.prompt("go");
        await waitForEntry(1);
        const mid = await agent.request("session/set_config_option", {
          sessionId: session.sessionId,
          configId: "agent",
          value: "zoe",
        });
        expect(idsOf(mid.configOptions)).not.toContain("agent");
        expect(await personaOf(session.sessionId)).toBe("max");
        release?.();
        await running;
      }),
    );
  });

  /**
   * @case A first turn the person cancelled still locks the persona
   * @preconditions A first message prompted, held open inside a tool, and cancelled through session/cancel, which leaves a transcript with no completed turn
   * @expectedResult The persona control stays withdrawn and a set is refused, because the transcript the cancelled turn kept is a transcript the next persona did not write. This is the ordinary case: a person sends one message and hits cancel
   */
  test("a cancelled first turn keeps the persona fixed", async () => {
    h = await boot();
    llm.script.push({ toolCalls: [{ toolName: "slow" }] }, { text: "after" });

    await h.connect(async (agent) => {
      const session = await agent.buildSession("/work").start();
      const running = agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
      await waitForEntry(1);
      await agent.notify("session/cancel", { sessionId: session.sessionId });
      await running;

      // The hazard is reachable: no turn was ever counted.
      const record = await AgentSessionRuntime.for(h!.t.ctx).store.load(
        session.sessionId,
      );
      expect(record?.turns).toBe(0);
      expect(record?.messages.length).toBeGreaterThan(0);

      const late = await agent.request("session/set_config_option", {
        sessionId: session.sessionId,
        configId: "agent",
        value: "zoe",
      });
      expect(idsOf(late.configOptions)).not.toContain("agent");
      expect(await personaOf(session.sessionId)).toBe("max");
      session.dispose();
    });
  });

  /**
   * @case A persona chosen in one window is the one the other window talks to
   * @preconditions One conversation open on two connections. The second connection resolves it (a set of its own) before the first connection changes the persona, which is exactly when a per-connection answer would go stale
   * @expectedResult The prompt from the second connection runs the persona the record names, on that persona's own model, because the id is the whole identity of a conversation and two connections can hold one
   */
  test("a persona change reaches a second connection", async () => {
    h = await boot();
    llm.script.push({ text: "zoe here" });

    await h.connect(async (first) => {
      await first.buildSession("/work").withSession(async (session) => {
        const id = session.sessionId;
        await h!.connect(async (second) => {
          // The second connection has now resolved this conversation,
          // while it still belongs to max.
          const held = await second.request("session/set_config_option", {
            sessionId: id,
            configId: "model",
            value: OPUS,
          });
          expect(valueOf(held.configOptions, "model")).toBe(OPUS);

          await first.request("session/set_config_option", {
            sessionId: id,
            configId: "agent",
            value: "zoe",
          });

          await second.request("session/prompt", {
            sessionId: id,
            prompt: [{ type: "text", text: "go" }],
          });
        });
      });
    });

    expect(llm.calls).toHaveLength(1);
    // Zoe's own model, and not the one chosen from max's list before the
    // change: a persona change clears what the conversation had chosen.
    expect(llm.calls[0]?.modelId).toBe("claude-haiku-4-5");
  });

  /**
   * @case The superseded modes API says the persona is fixed by offering only it
   * @preconditions One session resumed before its first turn and again after one, read through session/resume, which is where an old-API client learns its modes
   * @expectedResult Every persona is offered before the turn and only the current one after it. The block stays either way: dropping it would leave an old-API client not knowing which persona it is on, which is worse than a list it cannot move
   */
  test("the modes list collapses once the persona is fixed", async () => {
    h = await boot();
    llm.script.push({ text: "one" });

    await h.connect(async (agent) => {
      const session = await agent.buildSession("/work").start();
      const before = await agent.request("session/resume", {
        sessionId: session.sessionId,
        cwd: "/work",
      });
      expect(modeIdsOf(before)).toEqual(["max", "zoe"]);

      await agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "go" }],
      });

      const after = await agent.request("session/resume", {
        sessionId: session.sessionId,
        cwd: "/work",
      });
      expect(modeIdsOf(after)).toEqual(["max"]);
      expect(after.modes?.currentModeId).toBe("max");
      session.dispose();
    });
  });

  /**
   * @case A store failure during the persona change is an error, not a refusal
   * @preconditions A session store whose writes never land, so the change fails on the store rather than on the rule
   * @expectedResult The request fails. A refusal on this protocol is an unchanged list and therefore silence, so answering a broken store that way would leave an editor believing it had been told no
   */
  test("a store failure is not reported as a refusal", async () => {
    const store = new StallingStore();
    h = await acpHarness({
      agents: CHOOSY,
      acp: { agent: "max" },
      plugins: [agentPlugin({ functions: { slow: slowFn } })],
      sessionStore: store,
    });

    await h.connect(async (agent) => {
      const session = await agent.buildSession("/work").start();
      store.failWrites = true;
      await expect(
        agent.request("session/set_config_option", {
          sessionId: session.sessionId,
          configId: "agent",
          value: "zoe",
        }),
      ).rejects.toThrow();
      session.dispose();
    });
  });

  /**
   * @case The superseded modes API changes the persona too
   * @preconditions A fresh session, switched with session/set_mode rather than the config option
   * @expectedResult The persona moves and a current_mode_update is sent beside the config_option_update, so an editor speaking only the old API still works
   */
  test("session/set_mode maps onto the persona option", async () => {
    h = await boot();
    await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => {
        await agent.request("session/set_mode", {
          sessionId: session.sessionId,
          modeId: "zoe",
        });
      }),
    );
    const kinds = h.seen.map(
      (entry) => (entry.update as { sessionUpdate: string }).sessionUpdate,
    );
    expect(kinds).toEqual(["config_option_update", "current_mode_update"]);
  });
});
