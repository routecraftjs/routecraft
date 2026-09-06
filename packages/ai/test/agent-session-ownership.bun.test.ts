/**
 * A conversation belongs to the person who started it.
 *
 * The filter lives above whatever stores the records, so the tests here
 * are two-sided: each one first shows the hazard is reachable (a store
 * that hands back every key it holds, a session that exists and is
 * readable by its owner) and then that the guard withholds it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  HeadersKeys,
  MemorySuspensionStore,
  craft,
  direct,
  type Principal,
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
import { AgentSessionRuntime } from "../src/agent/session/index.ts";
import type { AgentSessionKey } from "../src/agent/session/types.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/suspend-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const ChatMessage = z.object({ session: z.string(), message: z.string() });
type ChatMessage = z.infer<typeof ChatMessage>;

/**
 * A store that answers every read, whoever is asking.
 *
 * This is the hazard the runtime filter exists for, written deliberately:
 * a consumer pointing `sessions: { store }` at their own backend can get
 * this wrong, and the framework's promise is that they still cannot leak
 * one caller's conversations to another. It delegates to the real memory
 * store so nothing else about it is unusual.
 */
class LeakyStore implements SessionStore {
  constructor(private readonly inner = new MemorySessionStore()) {}

  get(key: AgentSessionKey): Promise<StoredSession | undefined> {
    return this.inner.get(key);
  }
  create(key: AgentSessionKey, value: unknown): Promise<SessionCasResult> {
    return this.inner.create(key, value);
  }
  replace(
    key: AgentSessionKey,
    version: number,
    value: unknown,
  ): Promise<SessionCasResult> {
    return this.inner.replace(key, version, value);
  }
  /** Every key it holds, with no notion of who is asking. */
  keys(): Promise<AgentSessionKey[]> {
    return this.inner.keys();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

describe("a conversation belongs to the person who started it", () => {
  let t: TestContext | undefined;
  let store: LeakyStore;

  beforeEach(() => {
    llm.reset();
    store = new LeakyStore();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  function routes(sink: ReturnType<typeof spy>): RouteDefinition[] {
    return craft()
      .id("chat")
      .input({ body: ChatMessage })
      .from(direct())
      .to(agent<ChatMessage>("max", { session: (ex) => ex.body.session }))
      .to(sink)
      .build();
  }

  async function boot(): Promise<TestContext> {
    return testContext()
      .with({
        suspension: { store: new MemorySuspensionStore() },
        sessions: { store },
        shutdown: { timeout: 500 },
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            agents: {
              max: {
                description: "Max",
                model: MODEL,
                system: "be useful",
                user: (ex) => (ex.body as ChatMessage).message,
              },
            },
          }),
        ],
      })
      .routes(routes(spy()))
      .build();
  }

  function send(
    ctx: TestContext,
    body: ChatMessage,
    as: string | undefined,
  ): Promise<AgentResult> {
    const principal: Principal | undefined =
      as === undefined
        ? undefined
        : { kind: "custom", scheme: "test", subject: as };
    return ctx.client.sendDirect(
      "chat",
      body,
      principal === undefined
        ? {}
        : { [HeadersKeys.AUTH_PRINCIPAL]: principal },
    ) as Promise<AgentResult>;
  }

  /** Two conversations, one each, plus one nobody authenticated for. */
  async function threeSessions(ctx: TestContext): Promise<void> {
    llm.script.push({ text: "a" }, { text: "b" }, { text: "c" });
    await send(ctx, { session: "alices", message: "hi" }, "alice");
    await send(ctx, { session: "bobs", message: "hi" }, "bob");
    await send(ctx, { session: "nobodys", message: "hi" }, undefined);
  }

  /**
   * @case A listing returns only the caller's own conversations, over a store that returns everything
   * @preconditions Three sessions owned by alice, bob and nobody, over a store whose keys() deliberately hands back every key it holds
   * @expectedResult The store really does offer all three (the hazard is reachable), and each owner's listing carries exactly their own, so the filter cannot be defeated by a naive store
   */
  test("ownership is filtered above the store", async () => {
    t = await boot();
    await t.startAndWaitReady();
    await threeSessions(t);
    const runtime = AgentSessionRuntime.for(t.ctx);

    // The hazard, first: nothing in the store itself withholds a key.
    expect((await store.keys()).sort()).toEqual(["alices", "bobs", "nobodys"]);

    const alice = await runtime.summaries({ scope: { owner: "alice" } });
    expect(alice.items.map((s) => s.session)).toEqual(["alices"]);
    expect(alice.items[0]?.owner).toBe("alice");

    const bob = await runtime.summaries({ scope: { owner: "bob" } });
    expect(bob.items.map((s) => s.session)).toEqual(["bobs"]);

    // An unauthenticated caller owns the sessions no principal opened, and
    // those alone: `null` is an owner like any other, not a wildcard.
    const anon = await runtime.summaries({ scope: { owner: null } });
    expect(anon.items.map((s) => s.session)).toEqual(["nobodys"]);
  });

  /**
   * @case An operator scope sees every session whoever owns it
   * @preconditions The same three sessions, listed under the operator scope
   * @expectedResult All three come back with their owners reported, which is the deliberate privilege the management surface runs under
   */
  test("an operator scope sees every session", async () => {
    t = await boot();
    await t.startAndWaitReady();
    await threeSessions(t);

    const all = await AgentSessionRuntime.for(t.ctx).summaries({
      scope: "operator",
    });
    expect(all.items.map((s) => s.session).sort()).toEqual([
      "alices",
      "bobs",
      "nobodys",
    ]);
    expect(all.items.find((s) => s.session === "alices")?.owner).toBe("alice");
    expect(all.items.find((s) => s.session === "nobodys")?.owner).toBeNull();
  });

  /**
   * @case A foreign session and a missing one are indistinguishable from outside
   * @preconditions Alice's session read by alice, then by bob, then a session id nobody ever created read by bob
   * @expectedResult Alice gets her summary (so the read works and the hazard is reachable), and bob gets undefined for both, byte for byte, so guessing an id learns nothing about what exists
   */
  test("a foreign session answers exactly as a missing one", async () => {
    t = await boot();
    await t.startAndWaitReady();
    llm.script.push({ text: "a" });
    await send(t, { session: "alices", message: "hi" }, "alice");
    const runtime = AgentSessionRuntime.for(t.ctx);

    const mine = await runtime.summary("alices", { owner: "alice" });
    expect(mine?.session).toBe("alices");

    const foreign = await runtime.summary("alices", { owner: "bob" });
    const missing = await runtime.summary("never-existed", { owner: "bob" });
    expect(foreign).toBeUndefined();
    expect(missing).toBeUndefined();
    expect(foreign).toEqual(missing);
  });

  /**
   * @case Ownership is written once and a later turn under another principal does not transfer it
   * @preconditions Alice opens a session, then bob posts into the same session through the same route
   * @expectedResult The record still reports alice as the owner, because the field gates who may list and read the conversation and a second speaker is not a second owner
   */
  test("a later principal does not take over a conversation", async () => {
    t = await boot();
    await t.startAndWaitReady();
    llm.script.push({ text: "a" }, { text: "b" });
    await send(t, { session: "shared", message: "hi" }, "alice");
    await send(t, { session: "shared", message: "also me" }, "bob");

    const summary = await AgentSessionRuntime.for(t.ctx).summary(
      "shared",
      "operator",
    );
    expect(summary).toMatchObject({ owner: "alice", turns: 2 });
    expect(
      await AgentSessionRuntime.for(t.ctx).summary("shared", { owner: "bob" }),
    ).toBeUndefined();
  });

  /**
   * @case Opening a session records who it belongs to and where it is bound, before any turn
   * @preconditions A session opened through the runtime with an owner, a cwd and a title, and never prompted
   * @expectedResult The owner's listing carries it with both fields, and re-opening it as somebody else does not move it, so a conversation an editor created is already owned before its first message
   */
  test("opening a session records its owner, directory and title", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);
    const key = "opened";
    await runtime.open(key, "max", {
      owner: "alice",
      cwd: "/work/routecraft",
      title: "The editor seam",
    });

    const mine = await runtime.summary(key, { owner: "alice" });
    expect(mine).toMatchObject({
      owner: "alice",
      cwd: "/work/routecraft",
      title: "The editor seam",
      turns: 0,
    });

    await runtime.open(key, "max", { owner: "bob" });
    expect(await runtime.summary(key, { owner: "bob" })).toBeUndefined();
  });

  /**
   * @case A listing narrows to one directory
   * @preconditions Two sessions of one owner opened against different directories
   * @expectedResult Only the session bound to the requested directory comes back, which is what an editor asking for this workspace's conversations gets
   */
  test("a listing narrows to one directory", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);
    await runtime.open("here", "max", { owner: "alice", cwd: "/work/a" });
    await runtime.open("there", "max", { owner: "alice", cwd: "/work/b" });

    const page = await runtime.summaries({
      scope: { owner: "alice" },
      cwd: "/work/a",
    });
    expect(page.items.map((s) => s.session)).toEqual(["here"]);
  });

  /**
   * @case A page cursor cannot be replayed as another caller's page
   * @preconditions A cursor minted for alice's listing, presented on bob's
   * @expectedResult The read is refused rather than paging bob through alice's keys, because the scope is part of what the cursor is bound to
   */
  test("a cursor is bound to the scope that minted it", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);
    for (const session of ["a1", "a2", "a3"]) {
      await runtime.open(session, "max", { owner: "alice" });
    }
    const first = await runtime.summaries({
      scope: { owner: "alice" },
      limit: 2,
    });
    expect(first.nextCursor).toBeDefined();

    // The same cursor is honoured for the scope that minted it.
    const second = await runtime.summaries({
      scope: { owner: "alice" },
      limit: 2,
      after: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);

    await expect(
      runtime.summaries({
        scope: { owner: "bob" },
        limit: 2,
        after: first.nextCursor!,
      }),
    ).rejects.toThrow();
  });

  /**
   * @case A page cursor never carries somebody else's session identifier
   * @preconditions Four conversations under one agent, one of them owned by another person and sorting inside the first page's range, listed by the first person with a page size that leaves more to fetch
   * @expectedResult The returned cursor decodes to a key this caller is allowed to see. A cursor is minted from the last row of the page and handed to the caller, so a page sliced before the ownership filter would hand back a foreign session id in a reversible envelope, which is the identifier #731 says must be indistinguishable from one that does not exist
   */
  test("a page cursor cannot carry a foreign session id", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);
    // Sorted by `agent:session`, so bob's sits between alice's two.
    await runtime.open("a-1", "max", { owner: "alice" });
    await runtime.open("b-1", "max", { owner: "bob" });
    await runtime.open("c-1", "max", { owner: "alice" });
    await runtime.open("d-1", "max", { owner: "alice" });

    const page = await runtime.summaries({
      scope: { owner: "alice" },
      limit: 2,
    });
    // The hazard is reachable: there is more to page through, so a cursor
    // is minted rather than omitted.
    expect(page.nextCursor).toBeDefined();

    const decoded = JSON.parse(
      Buffer.from(page.nextCursor ?? "", "base64url").toString("utf8"),
    ) as { after?: string };
    // The cursor carries the id itself now: there is no agent prefix to
    // strip, which is one fewer thing for it to leak.
    const after = decoded.after ?? "";
    // The exact row the page ended on, not merely "not bob's": a negative
    // assertion still passes if a regression mints the cursor from some
    // other foreign row, and this test is the only thing standing between
    // the leak and its return.
    expect(after).toBe("c-1");
  });

  /**
   * @case Changing the persona leaves one record, not two
   * @preconditions A conversation opened under one agent and switched to another before it has said anything, then resolved by its bare session id
   * @expectedResult The id names the new agent and the store holds one record, so resolution does not depend on which record a store enumerates first
   */
  test("a persona change leaves no second record behind", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);
    const session = "moved";

    await runtime.open(session, "max", { owner: "alice" });
    // The hazard is reachable: before the change the id names the original.
    expect(await runtime.find(session, { owner: "alice" })).toBe("max");

    await runtime.setAgent(session, "zoe");

    expect(await runtime.find(session, { owner: "alice" })).toBe("zoe");
    // And there is one record, not two. Under a composite key this is
    // where the abandoned original would still be sitting.
    expect(await runtime.store.list()).toEqual([session]);
  });

  /**
   * @case A persona change keeps the record and switches which agent answers
   * @preconditions A conversation opened under one agent, its persona changed, then read back
   * @expectedResult One record throughout, carrying the new agent. The id is the identity, so nothing is re-keyed and nothing is deleted
   */
  test("a persona change is one field on one record", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);
    const session = "switcher";

    await runtime.open(session, "max", { owner: "alice" });
    expect((await runtime.summary(session, { owner: "alice" }))?.agent).toBe(
      "max",
    );

    await runtime.setAgent(session, "zoe");

    const after = await runtime.summary(session, { owner: "alice" });
    expect(after?.agent).toBe("zoe");
    expect(after?.session).toBe(session);
    expect(await runtime.store.list()).toEqual([session]);
  });

  /**
   * @case A reconnect by bare session id resolves without enumerating the store
   * @preconditions A conversation the caller owns, resolved by its id alone against a store that would happily hand back every key
   * @expectedResult The agent comes back from one read, and a foreign id answers undefined exactly as a missing one does
   */
  test("a bare session id resolves in one read", async () => {
    t = await boot();
    await t.startAndWaitReady();
    const runtime = AgentSessionRuntime.for(t.ctx);

    await runtime.open("mine", "max", { owner: "alice" });
    await runtime.open("theirs", "max", { owner: "bob" });

    expect(await runtime.find("mine", { owner: "alice" })).toBe("max");
    // Somebody else's, and one that was never written, answer alike.
    expect(await runtime.find("theirs", { owner: "alice" })).toBeUndefined();
    expect(await runtime.find("never", { owner: "alice" })).toBeUndefined();
  });
});
