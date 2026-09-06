/**
 * One conversation is answered by one persona, for its whole life.
 *
 * A persona carries a system prompt and a set of tools, so a conversation
 * that changed persona mid-flight would hand a model a transcript another
 * persona wrote and answers produced with tools it does not have. The
 * choice is made before the first message and fixed after it, and these
 * tests hold the three ways that could be got around: a dispatch naming
 * another persona, a change racing a prompt, and a stale setting carried
 * across a change.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  MemorySuspensionStore,
  craft,
  direct,
  type RouteDefinition,
} from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  MemorySessionStore,
  agent,
  agentPlugin,
  llmPlugin,
  type AgentResult,
  type SessionCasResult,
  type SessionStore,
  type StoredSession,
} from "../src/index.ts";
import type { AgentSessionKey } from "../src/agent/session/types.ts";
import { AgentSessionRuntime } from "../src/agent/session/index.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const SONNET = "anthropic:claude-sonnet-4-6";
const HAIKU = "anthropic:claude-haiku-4-5";

const ChatMessage = z.object({ session: z.string(), message: z.string() });
type ChatMessage = z.infer<typeof ChatMessage>;

/**
 * A store that can hold one write open, so the gap between reading a
 * record and writing it back is a gap a test can put a whole turn inside.
 * Everything else delegates to the real in-memory backend.
 */
class GatingStore implements SessionStore {
  readonly inner = new MemorySessionStore();
  #armed = false;
  #entered: (() => void) | undefined;
  #released: Promise<void> | undefined;

  /** Hold the next `replace` until the returned release is called. */
  arm(): { entered: Promise<void>; release: () => void } {
    this.#armed = true;
    const entered = new Promise<void>((resolve) => (this.#entered = resolve));
    let release = (): void => undefined;
    this.#released = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    return { entered, release };
  }

  get(key: AgentSessionKey): Promise<StoredSession | undefined> {
    return this.inner.get(key);
  }
  create(key: AgentSessionKey, value: unknown): Promise<SessionCasResult> {
    return this.inner.create(key, value);
  }
  async replace(
    key: AgentSessionKey,
    version: number,
    value: unknown,
  ): Promise<SessionCasResult> {
    if (this.#armed) {
      this.#armed = false;
      this.#entered?.();
      await this.#released;
    }
    return this.inner.replace(key, version, value);
  }
  keys(): Promise<AgentSessionKey[]> {
    return this.inner.keys();
  }
  remove(key: AgentSessionKey): Promise<void> {
    return this.inner.remove(key);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

describe("one conversation, one persona", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /** Two personas on two routes, each dispatching by the id in the message. */
  function routes(): RouteDefinition[] {
    return [
      ...craft()
        .id("to-max")
        .input({ body: ChatMessage })
        .from(direct())
        .to(agent<ChatMessage>("max", { session: (ex) => ex.body.session }))
        .to(spy())
        .build(),
      ...craft()
        .id("to-zoe")
        .input({ body: ChatMessage })
        .from(direct())
        .to(agent<ChatMessage>("zoe", { session: (ex) => ex.body.session }))
        .to(spy())
        .build(),
    ];
  }

  async function boot(store?: SessionStore): Promise<TestContext> {
    return testContext()
      .with({
        suspension: { store: new MemorySuspensionStore() },
        sessions: { store: store ?? new MemorySessionStore() },
        shutdown: { timeout: 500 },
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            agents: {
              max: {
                description: "Max",
                model: SONNET,
                models: [SONNET, HAIKU],
                system: "be Max",
                user: (ex) => (ex.body as ChatMessage).message,
              },
              zoe: {
                description: "Zoe",
                model: HAIKU,
                system: "be Zoe",
                user: (ex) => (ex.body as ChatMessage).message,
              },
            },
          }),
        ],
      })
      .routes(routes())
      .build();
  }

  function send(
    ctx: TestContext,
    route: "to-max" | "to-zoe",
    body: ChatMessage,
  ): Promise<AgentResult> {
    return ctx.client.sendDirect(route, body) as Promise<AgentResult>;
  }

  /**
   * @case A second persona dispatched at somebody else's conversation is refused, not served
   * @preconditions One session id answered by max, then the same id dispatched at the route that runs zoe
   * @expectedResult The hazard is reachable (zoe answers that id perfectly well when it is her own conversation) and the collision is refused with RC5003 naming both personas, leaving max's transcript as the only thing in the record
   */
  test("a dispatch naming another persona is refused", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);

    llm.script.push({ text: "max here" }, { text: "zoe here" });
    await send(t, "to-max", { session: "shared", message: "hello" });

    // Reachable: zoe runs, and runs this same route, when the id is hers.
    await send(t, "to-zoe", { session: "zoes-own", message: "hello" });
    expect((await runtime.store.load("zoes-own"))?.agent).toBe("zoe");

    await expect(
      send(t, "to-zoe", { session: "shared", message: "hello again" }),
    ).rejects.toThrow(/belongs to "max" and this dispatch names "zoe"/);

    const record = await runtime.store.load("shared");
    expect(record?.agent).toBe("max");
    // Nothing of zoe's reached the transcript: one user message, one reply.
    expect(record?.messages).toHaveLength(2);
    expect(record?.turns).toBe(1);
  });

  /**
   * @case A turn that starts inside the persona change's own read-to-write gap does not let the change land
   * @preconditions A conversation opened under max with nothing said yet. A store that holds the change's write open, and a whole turn under max run and completed inside that gap before the write is released
   * @expectedResult The held write loses its compare-and-swap, re-reads the turn max ran, and is refused. The record still names max and carries max's transcript, so the check and the write are one act rather than two
   */
  test("a persona change cannot land around a turn that started inside it", async () => {
    const store = new GatingStore();
    t = await boot(store);
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);
    const session = "gap";
    await runtime.open(session, "max", { owner: null });

    const gate = store.arm();
    const change = runtime.setAgent(session, "zoe");
    // Held as an outcome rather than asserted here: the refusal cannot be
    // read until the write is released, and a rejection nobody is holding
    // while the turn runs is an unhandled one.
    const refused = change.then(
      () => undefined,
      (err: unknown) => err,
    );
    await gate.entered;

    // The whole turn, inside the gap: max answers and the record is max's.
    llm.script.push({ text: "max here" });
    const answer = await send(t, "to-max", { session, message: "hello" });
    expect(answer.text).toBe("max here");

    gate.release();
    expect(String(await refused)).toMatch(/has already started/);

    const record = await runtime.store.load(session);
    expect(record?.agent).toBe("max");
    expect(record?.turns).toBe(1);
    expect(record?.messages).toHaveLength(2);
  });

  /**
   * @case A persona change refuses once the conversation has started
   * @preconditions A conversation that has run one turn under max
   * @expectedResult RC5003 naming the conversation, and the record still names max, so the rule holds at the runtime and not only at the surface that calls it
   */
  test("a persona change after the first turn is refused", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);

    llm.script.push({ text: "max here" });
    await send(t, "to-max", { session: "started", message: "hello" });

    await expect(runtime.setAgent("started", "zoe")).rejects.toThrow(
      /has already started/,
    );
    expect((await runtime.store.load("started"))?.agent).toBe("max");
  });

  /**
   * @case What the conversation chose does not survive the persona change
   * @preconditions A conversation on max with a model chosen from what max advertises, switched to zoe before it has said anything
   * @expectedResult The record carries no overrides afterwards, so the next turn runs on zoe's own default rather than on a model chosen from another agent's list
   */
  test("a persona change clears the model and thinking level", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);
    const session = "chosen";

    await runtime.open(session, "max", { owner: null });
    await runtime.configure(session, "max", { model: HAIKU });
    expect((await runtime.store.load(session))?.overrides).toEqual({
      model: HAIKU,
    });

    await runtime.setAgent(session, "zoe");
    expect((await runtime.store.load(session))?.overrides).toBeUndefined();
  });
});
