/**
 * Who the editor seam admits, and whose conversations they can see.
 *
 * Two-sided throughout: each case first shows the thing is reachable with
 * the right credential, then that it is withheld without it. A one-sided
 * test passes green on a machine with nothing to hide.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import type { Principal } from "@routecraft/routecraft";
import { agentPlugin, tools, type FnHandlerContext } from "../src/index.ts";
import { acpHarness, type AcpHarness } from "./helpers/acp-harness.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/suspend-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

/** Tokens the harness's validator admits, and who each is. */
const PEOPLE: Record<string, string> = {
  "alice-token": "alice",
  "bob-token": "bob",
};

function validator(token: string): Principal {
  const subject = PEOPLE[token];
  if (subject === undefined) throw new Error("bad token");
  return { kind: "custom", scheme: "bearer", subject };
}

/** Who the turn ran as, captured from inside a hand. */
let ranAs: Array<string | null> = [];
const whoamiFn = {
  description: "Reports the caller",
  input: z.object({}),
  handler: (_input: unknown, ctx: FnHandlerContext) => {
    ranAs.push(ctx.principal?.subject ?? null);
    return Promise.resolve("ok");
  },
};

const AGENT = {
  max: {
    description: "Max",
    model: MODEL,
    system: "be useful",
    user: (ex: { body: unknown }) => (ex.body as { message: string }).message,
    tools: tools(["whoami"]),
  },
};

describe("the ACP mount's door", () => {
  let h: AcpHarness | undefined;

  beforeEach(() => {
    llm.reset();
    ranAs = [];
  });

  afterEach(async () => {
    if (h) await h.t.stop();
    h = undefined;
  });

  async function walled(): Promise<AcpHarness> {
    return acpHarness({
      agents: AGENT,
      validator,
      plugins: [agentPlugin({ functions: { whoami: whoamiFn } })],
    });
  }

  /**
   * @case A good token is admitted and the turn runs as its holder; a bad one never reaches the protocol
   * @preconditions A mount on a server carrying a bearer validator, driven once with a valid token and once with a rejected one
   * @expectedResult The valid connection opens and a hand inside the turn sees "alice" as the caller, and the invalid one fails to connect at all, so the refusal happened before the SDK saw a request
   */
  test("the mount is walled on both sides", async () => {
    h = await walled();
    llm.script.push({ toolCalls: [{ toolName: "whoami" }] }, { text: "done" });

    const good = await h.connect(
      (agent) =>
        agent
          .buildSession("/work")
          .withSession((session) => session.prompt("who am I")),
      { token: "alice-token" },
    );
    expect(good.stopReason).toBe("end_turn");
    // The hazard is reachable: with the right credential the turn runs and
    // every hand it calls runs under the person who typed the prompt.
    expect(ranAs).toEqual(["alice"]);

    await expect(
      h.connect(async () => undefined, { token: "not-a-token" }),
    ).rejects.toThrow();
    await expect(h.connect(async () => undefined)).rejects.toThrow();
    // And nothing ran under either refusal.
    expect(ranAs).toEqual(["alice"]);
  });

  /**
   * @case A listing carries the caller's own conversations and nobody else's
   * @preconditions Two people each opening a conversation on one instance, then each listing
   * @expectedResult Alice's listing carries her session and not Bob's, and Bob's the reverse, over a store that holds both
   */
  test("session/list is one person's own", async () => {
    h = await walled();
    llm.script.push({ text: "a" }, { text: "b" });

    const alices = await h.connect(
      (agent) =>
        agent.buildSession("/alice").withSession(async (session) => {
          await session.prompt("hello");
          return session.sessionId;
        }),
      { token: "alice-token" },
    );
    const bobs = await h.connect(
      (agent) =>
        agent.buildSession("/bob").withSession(async (session) => {
          await session.prompt("hello");
          return session.sessionId;
        }),
      { token: "bob-token" },
    );
    expect(alices).not.toBe(bobs);

    const forAlice = await h.connect(
      (agent) => agent.request("session/list", {}),
      { token: "alice-token" },
    );
    const forBob = await h.connect(
      (agent) => agent.request("session/list", {}),
      { token: "bob-token" },
    );
    expect(forAlice.sessions.map((s) => s.sessionId)).toEqual([alices]);
    expect(forBob.sessions.map((s) => s.sessionId)).toEqual([bobs]);
    // The directory each was opened in comes back with it, which is what a
    // listing narrowed to one workspace is filtered on.
    expect(forAlice.sessions[0]?.cwd).toBe("/alice");
  });

  /**
   * @case A listing narrows to one directory
   * @preconditions One person with two conversations, opened in different directories
   * @expectedResult Asking for one directory returns only the conversation bound to it, and asking for neither returns both
   */
  test("session/list narrows to a directory", async () => {
    h = await walled();
    llm.script.push({ text: "a" }, { text: "b" });
    await h.connect(
      (agent) =>
        agent
          .buildSession("/one")
          .withSession((session) => session.prompt("hello")),
      { token: "alice-token" },
    );
    await h.connect(
      (agent) =>
        agent
          .buildSession("/two")
          .withSession((session) => session.prompt("hello")),
      { token: "alice-token" },
    );

    const all = await h.connect((agent) => agent.request("session/list", {}), {
      token: "alice-token",
    });
    const one = await h.connect(
      (agent) => agent.request("session/list", { cwd: "/one" }),
      { token: "alice-token" },
    );
    expect(all.sessions).toHaveLength(2);
    expect(one.sessions.map((s) => s.cwd)).toEqual(["/one"]);
  });

  /**
   * @case Loading somebody else's conversation answers exactly as loading one that never existed
   * @preconditions Alice's real session id, presented by Bob, beside an id nobody ever issued
   * @expectedResult Alice can load her own, and Bob gets the same error message for the real id and the invented one, so guessing an id learns nothing about what exists
   */
  test("a foreign session and a missing one are indistinguishable", async () => {
    h = await walled();
    llm.script.push({ text: "a" });
    const alices = await h.connect(
      (agent) =>
        agent.buildSession("/alice").withSession(async (session) => {
          await session.prompt("hello");
          return session.sessionId;
        }),
      { token: "alice-token" },
    );

    // Reachable for its owner: the load works, so the refusals below are
    // about who is asking rather than about the method being broken.
    const mine = await h.connect(
      (agent) =>
        agent.request("session/load", {
          sessionId: alices,
          cwd: "/alice",
          mcpServers: [],
        }),
      { token: "alice-token" },
    );
    expect(mine).toBeDefined();

    const foreign = await h
      .connect(
        (agent) =>
          agent.request("session/load", {
            sessionId: alices,
            cwd: "/bob",
            mcpServers: [],
          }),
        { token: "bob-token" },
      )
      .catch((error: Error) => error.message);
    const invented = await h
      .connect(
        (agent) =>
          agent.request("session/load", {
            sessionId: "11111111-2222-3333-4444-555555555555",
            cwd: "/bob",
            mcpServers: [],
          }),
        { token: "bob-token" },
      )
      .catch((error: Error) => error.message);

    expect(foreign).toBe(invented);
    expect(String(foreign)).toContain("No such session");
  });

  /**
   * @case An unwalled mount serves everybody as the same anonymous caller
   * @preconditions No validator on the server, two connections opening one conversation each
   * @expectedResult Both listings carry both conversations, because with nobody authenticated there is nobody to tell apart, and the turn runs with no principal
   */
  test("with no wall there is nobody to tell apart", async () => {
    h = await acpHarness({
      agents: AGENT,
      plugins: [agentPlugin({ functions: { whoami: whoamiFn } })],
    });
    llm.script.push(
      { toolCalls: [{ toolName: "whoami" }] },
      { text: "a" },
      { text: "b" },
    );
    await h.connect((agent) =>
      agent.buildSession("/one").withSession((s) => s.prompt("hello")),
    );
    await h.connect((agent) =>
      agent.buildSession("/two").withSession((s) => s.prompt("hello")),
    );
    expect(ranAs).toEqual([null]);

    const listed = await h.connect((agent) =>
      agent.request("session/list", {}),
    );
    expect(listed.sessions).toHaveLength(2);
  });
});
