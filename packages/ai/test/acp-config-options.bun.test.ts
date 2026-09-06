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
  modes?: { availableModes: Array<{ id: string }> } | null | undefined;
}): string[] {
  return (response.modes?.availableModes ?? []).map((mode) => mode.id);
}

/** Which controls a response carries at all, for the ones that are withdrawn. */
function idsOf(options: Array<{ id: string }> | null | undefined): string[] {
  return (options ?? []).map((option) => option.id);
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
   * @case Which agent answers is not a configuration option at all
   * @preconditions A mount holding two agents, asked to set "agent" on a fresh session, which is the state the old design allowed the change in
   * @expectedResult The option is absent from the list and the set errors as an unknown id rather than answering an unchanged list. A refusal here would be silence on this protocol; an unknown id is the truthful answer, because this mount has no such control
   */
  test("agent is not among the config options", async () => {
    h = await boot();
    await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => {
        const opened = await agent.request("session/resume", {
          sessionId: session.sessionId,
          cwd: "/work",
        });
        expect(idsOf(opened.configOptions)).toEqual(["model", "reasoning"]);
        expect(idsOf(opened.configOptions)).not.toContain("agent");

        await expect(
          agent.request("session/set_config_option", {
            sessionId: session.sessionId,
            configId: "agent",
            value: "zoe",
          }),
        ).rejects.toThrow(/No configuration option "agent"/);

        expect(await personaOf(session.sessionId)).toBe("max");
      }),
    );
  });

  /**
   * @case The mount advertises no modes, and session/set_mode is not implemented
   * @preconditions A mount holding two agents, which is where the old design offered them as modes
   * @expectedResult No mode state on session/new or session/resume, and set_mode answers the protocol's own method-not-found. Routecraft has no concept that behaves like an ACP mode, so it advertises none rather than advertising one that cannot move
   */
  test("no modes are advertised and set_mode is unimplemented", async () => {
    h = await boot();
    await h.connect(async (agent) => {
      const created = await agent.buildSession("/work").start();
      expect(modeIdsOf(created)).toEqual([]);

      const resumed: { modes?: unknown } = await agent.request(
        "session/resume",
        { sessionId: created.sessionId, cwd: "/work" },
      );
      expect(resumed.modes ?? null).toBeNull();

      await expect(
        agent.request("session/set_mode", {
          sessionId: created.sessionId,
          modeId: "zoe",
        }),
      ).rejects.toThrow(/Method not found/);
      created.dispose();
    });
  });

  /**
   * @case The model stays changeable while a turn is running
   * @preconditions A turn held open inside a tool, with the model changed mid-flight
   * @expectedResult The change is accepted and the running turn finishes on the model it started with. Which agent answers is fixed for a conversation's life; how it answers is not, and a turn in flight is the sharpest case of that
   */
  test("the model can be changed mid-turn", async () => {
    h = await boot();
    llm.script.push({ toolCalls: [{ toolName: "slow" }] }, { text: "done" });

    await h.connect((agent) =>
      agent.buildSession("/work").withSession(async (session) => {
        const running = session.prompt("go");
        await waitForEntry(1);

        const mid = await agent.request("session/set_config_option", {
          sessionId: session.sessionId,
          configId: "model",
          value: OPUS,
        });
        expect(valueOf(mid.configOptions, "model")).toBe(OPUS);

        release?.();
        await running;
        // The turn it interrupted ran on the model it opened with: an
        // override is read when a turn starts, not partway through one.
        // The provider sees the id without its provider prefix.
        expect(llm.calls[0]?.modelId).toBe(SONNET.split(":")[1]);
      }),
    );
  });

  /**
   * @case A harness serves only its own agent's conversations
   * @preconditions One owner with a session created through the max harness and one through the zoe harness, then each addressed through the other
   * @expectedResult Each harness lists, loads, resumes and prompts only its own, and answers the other's id exactly as it answers one that was never created. The zoe harness reaches the zoe session perfectly well, so the refusal is the harness boundary rather than a broken session
   */
  test("a harness cannot see or address another agent's session", async () => {
    h = await boot();

    const maxSession = await h.connect(
      async (agent) => (await agent.buildSession("/work").start()).sessionId,
      { agent: "max" },
    );
    const zoeSession = await h.connect(
      async (agent) => (await agent.buildSession("/work").start()).sessionId,
      { agent: "zoe" },
    );
    expect(await personaOf(maxSession)).toBe("max");
    expect(await personaOf(zoeSession)).toBe("zoe");

    await h.connect(
      async (agent) => {
        const listed = await agent.request("session/list", { cwd: null });
        const ids = listed.sessions.map(
          (s: { sessionId: string }) => s.sessionId,
        );
        expect(ids).toContain(maxSession);
        expect(ids).not.toContain(zoeSession);

        // Load, resume and prompt: every door into a conversation.
        await expect(
          agent.request("session/load", {
            sessionId: zoeSession,
            cwd: "/work",
            mcpServers: [],
          }),
        ).rejects.toThrow(/No such session/);
        await expect(
          agent.request("session/resume", {
            sessionId: zoeSession,
            cwd: "/work",
          }),
        ).rejects.toThrow(/No such session/);
        await expect(
          agent.request("session/prompt", {
            sessionId: zoeSession,
            prompt: [{ type: "text", text: "hello" }],
          }),
        ).rejects.toThrow(/No such session/);
      },
      { agent: "max" },
    );

    // Reachable through its own harness, so the refusal above is the
    // boundary and not a session that never worked.
    llm.script.push({ text: "zoe here" });
    await h.connect(
      async (agent) => {
        const loaded: {
          configOptions?: Array<{ id: string }> | null;
        } = await agent.request("session/load", {
          sessionId: zoeSession,
          cwd: "/work",
          mcpServers: [],
        });
        // zoe names one model and no thinking list, so it advertises no
        // controls: nothing to choose is not advertised.
        expect(idsOf(loaded.configOptions)).toEqual([]);
        const answer: { stopReason: string } = await agent.request(
          "session/prompt",
          { sessionId: zoeSession, prompt: [{ type: "text", text: "hello" }] },
        );
        expect(answer.stopReason).toBe("end_turn");
        // The scripted answer, not merely a turn that ended: an entry left
        // in the queue by an earlier refusal would satisfy the stop reason
        // and answer with somebody else's text.
        const said = h!.seen
          .filter((entry) => entry.sessionId === zoeSession)
          .map((entry) => entry.update as { content?: { text?: string } })
          .map((update) => update.content?.text ?? "")
          .join("");
        expect(said).toContain("zoe here");
      },
      { agent: "zoe" },
    );

    expect(await personaOf(zoeSession)).toBe("zoe");
  });

  /**
   * @case A wrong-agent session id answers exactly as an id that does not exist
   * @preconditions The zoe session's real id and a random one, both addressed through the max harness
   * @expectedResult The two failures carry the same message, so which conversations a person holds under another harness is not readable from this one
   */
  test("a wrong-agent id is indistinguishable from a missing one", async () => {
    h = await boot();
    const zoeSession = await h.connect(
      async (agent) => (await agent.buildSession("/work").start()).sessionId,
      { agent: "zoe" },
    );

    await h.connect(
      async (agent) => {
        const wrongAgent = await agent
          .request("session/load", {
            sessionId: zoeSession,
            cwd: "/work",
            mcpServers: [],
          })
          .then(
            () => undefined,
            (err: unknown) => String(err),
          );
        const missing = await agent
          .request("session/load", {
            sessionId: "00000000-0000-4000-8000-000000000000",
            cwd: "/work",
            mcpServers: [],
          })
          .then(
            () => undefined,
            (err: unknown) => String(err),
          );
        expect(wrongAgent).toBeDefined();
        expect(wrongAgent).toBe(missing);
      },
      { agent: "max" },
    );
  });

  /**
   * @case A store failure during a config change is an error, not a refusal
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
          configId: "model",
          value: OPUS,
        }),
      ).rejects.toThrow();
      session.dispose();
    });
  });
});
