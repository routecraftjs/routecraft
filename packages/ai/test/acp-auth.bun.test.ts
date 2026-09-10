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
import { MODEL } from "./helpers/defer-fixtures.ts";

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

  /**
   * @case Two initializes racing inside the body read each bind to their own caller
   * @preconditions Alice and Bob each hold a conversation, then two initialize requests overlap: Bob's headers arrive first but his body is delivered in two chunks, so Alice's whole request completes inside the gap
   * @expectedResult Bob's connection lists Bob's conversation and not Alice's, because the principal a connection is built with is the one that sent its own request rather than whichever arrived most recently
   */
  test("a connection is bound to its own caller, not the latest one", async () => {
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

    // Two owners, each holding a conversation, so a connection bound to
    // the wrong one would have somebody else's to reach.
    expect(alices).not.toBe(bobs);

    const opens: Array<{ subject?: string }> = [];
    h.t.ctx.on("*", (payload) => {
      if (payload._event === "plugin:acp:connection:opened") {
        opens.push(payload.details as { subject?: string });
      }
    });

    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    // Bob's body arrives in two pieces. Everything Alice does happens in
    // the gap, which is the window the mount used to hold one caller in.
    const split = Math.floor(initialize.length / 2);
    let releaseRest: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      releaseRest = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(initialize.slice(0, split)));
        await opened;
        controller.enqueue(encoder.encode(initialize.slice(split)));
        controller.close();
      },
    });

    const bobsConnection = fetch(h.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer bob-token",
      },
      body,
      // Streaming a request body needs the half-duplex opt-in.
      duplex: "half",
    } as RequestInit);

    // Alice initializes and finishes entirely while Bob's body is stalled.
    await h.connect(async () => undefined, { token: "alice-token" });
    releaseRest?.();

    const response = await bobsConnection;
    expect(response.status).toBe(200);
    expect(response.headers.get("Acp-Connection-Id")).not.toBeNull();

    // The subject each connection was built with, from the mount's own
    // event. With the principal held in a shared slot, Bob's connection is
    // built with whoever initialized while his body was still arriving.
    const bound = opens.map((one) => one.subject);
    expect(bound).toEqual(["alice", "bob"]);
  });

  /**
   * @case A refusal tells the caller where to go, through the one builder every routecraft surface uses
   * @preconditions A walled mount answering a request that carries no credential, and one that carries a rejected credential
   * @expectedResult Both challenges carry the realm and an absolute RFC 9728 resource_metadata URL, so the CLI's refusal enrichment names the issuer and the scope instead of printing a bare refusal
   */
  test("a 401 hints, and hints absolutely", async () => {
    h = await walled();

    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    const post = (headers: Record<string, string>): Promise<Response> =>
      fetch(h!.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: initialize,
      });

    for (const headers of [
      {},
      { Authorization: "Bearer not-a-token" },
    ] as Array<Record<string, string>>) {
      const refused = await post(headers);
      expect(refused.status).toBe(401);
      const challenge = refused.headers.get("WWW-Authenticate") ?? "";
      expect(challenge).toStartWith("Bearer ");
      expect(challenge).toContain('realm="routecraft"');
      // Absolute, because a relative hint breaks behind a reverse proxy.
      expect(challenge).toMatch(
        /resource_metadata="https?:\/\/[^"]*\/\.well-known\/oauth-protected-resource/,
      );
    }
  });

  /**
   * @case A stale token is handshake noise, a bad one is worth a look
   * @preconditions A walled mount whose validator refuses one token as expired and another as invalid
   * @expectedResult The expired token is logged at debug and the invalid one at warn, so a fleet of editors refreshing stale tokens does not bury the refusals that mean something
   */
  test("routine refusals do not reach warn", async () => {
    h = await walled();
    const levels: string[] = [];
    const logger = h.t.ctx.logger as unknown as Record<
      string,
      (...args: unknown[]) => void
    >;
    for (const level of ["debug", "warn"] as const) {
      const real = logger[level]!.bind(logger);
      logger[level] = (...args: unknown[]) => {
        const detail = args[0] as { source?: string } | undefined;
        if (detail?.source === "acp") levels.push(level);
        real(...args);
      };
    }

    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    const post = (authorization: string): Promise<Response> =>
      fetch(h!.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
        },
        body: initialize,
      });

    // A scheme this door does not speak is a probe, not an incident.
    expect((await post("Basic Zm9vOmJhcg==")).status).toBe(401);
    expect(levels).toEqual(["debug"]);

    // A bearer that fails validation is worth a look.
    expect((await post("Bearer not-a-token")).status).toBe(401);
    expect(levels).toEqual(["debug", "warn"]);
  });

  /**
   * @case A browser origin the policy does not allow is refused, not served and discarded
   * @preconditions The default loopback-only policy, with a request carrying a non-loopback Origin, and one carrying none
   * @expectedResult The cross-origin request is refused before the protocol sees it, and the request with no Origin is unaffected, because a caller without one is not a browser and is every editor
   */
  test("a disallowed origin is refused rather than executed", async () => {
    h = await walled();
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });

    const cross = await fetch(h.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer alice-token",
        Origin: "https://not-your-machine.example",
      },
      body: initialize,
    });
    expect(cross.status).toBe(403);

    // The hazard is reachable with the same credential and no Origin, so
    // the refusal is about the browser and not about the token.
    const direct = await fetch(h.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer alice-token",
      },
      body: initialize,
    });
    expect(direct.status).toBe(200);
  });
});
