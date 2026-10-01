/**
 * What the ACP mount puts on the wire when a request fails.
 *
 * The mount is a door: its callers are outside the process, so a failure
 * crosses as a JSON-RPC code and, at most, an RC code. The message, which
 * routinely names hosts, paths and upstream text, stays in the operator's
 * log. The mount's own deliberate refusals are the exception, because they
 * are written for the caller.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { acpHarness, type AcpHarness } from "./helpers/acp-harness.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";
import {
  MemorySessionStore,
  type SessionCasResult,
  type SessionStore,
  type StoredSession,
} from "../src/agent/session/index.ts";

/** Instance-owned detail no caller may read back. */
const HOST = "db.internal.example:5432";
const PATH = "/srv/secrets/tenant.key";
const LEAK = `connect ECONNREFUSED ${HOST} while reading ${PATH}`;

/** A store that delegates to memory until a test tells it to fail. */
class FailingStore implements SessionStore {
  readonly inner = new MemorySessionStore();
  failReads = false;
  failCreates = false;

  get(key: string): Promise<StoredSession | undefined> {
    return this.inner.get(key);
  }
  create(key: string, value: unknown): Promise<SessionCasResult> {
    if (this.failCreates) return Promise.reject(new Error(LEAK));
    return this.inner.create(key, value);
  }
  replace(
    key: string,
    version: number,
    value: unknown,
  ): Promise<SessionCasResult> {
    return this.inner.replace(key, version, value);
  }
  keys(): Promise<string[]> {
    if (this.failReads) return Promise.reject(new Error(LEAK));
    return this.inner.keys();
  }
  remove(key: string): Promise<void> {
    return this.inner.remove(key);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

/** The JSON-RPC error a request was answered with, or a failure if none. */
function refusalOf(request: Promise<unknown>): Promise<{
  code: number;
  message: string;
  data?: unknown;
}> {
  return request.then(
    () => {
      throw new Error("expected the request to be refused");
    },
    (error: unknown) =>
      error as { code: number; message: string; data?: unknown },
  );
}

/** Everything the caller received about one failure, as one string. */
function wireText(answer: { message: string; data?: unknown }): string {
  return JSON.stringify({ message: answer.message, data: answer.data });
}

const BROKEN = {
  max: {
    description: "Max, whose prompt builder fails",
    model: MODEL,
    system: "be useful",
    user: (): string => {
      throw new Error(LEAK);
    },
  },
};

const PLAIN = {
  max: { description: "Max", model: MODEL, system: "be useful" },
};

describe("ACP mount failures on the wire", () => {
  let h: AcpHarness | undefined;

  afterEach(async () => {
    if (h) await h.t.stop();
    h = undefined;
  });

  /**
   * @case A turn whose agent route fails answers the editor without the failure's message
   * @preconditions An agent whose prompt builder throws an error naming a hostname and a file path; a session opened on it and prompted
   * @expectedResult The prompt is answered -32603 "Internal error" with only the RC code in data, neither the hostname nor the path reaches the caller, and the operator's log carries the full message once at error
   */
  test("a failed turn answers -32603 with the code and no message", async () => {
    h = await acpHarness({ agents: BROKEN });

    const answer = await h.connect(async (agent) => {
      const session = await agent.buildSession("/work").start();
      const refused = await refusalOf(
        agent.request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        }),
      );
      session.dispose();
      return refused;
    });

    expect(answer.code).toBe(-32603);
    expect(answer.message).toBe("Internal error");
    expect(answer.data).toEqual({ code: "RC5001" });
    expect(wireText(answer)).not.toContain(HOST);
    expect(wireText(answer)).not.toContain(PATH);

    const logged = h.t.contextLogger.error.mock.calls.filter(
      (call) =>
        (call[0] as { method?: string } | undefined)?.method ===
        "session/prompt",
    );
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[1])).toContain(HOST);
  });

  /**
   * @case A store outage answers the editor without the store's message, on every request it reaches
   * @preconditions A session store whose enumeration and creation reject with an error naming a hostname and a file path
   * @expectedResult session/list and session/new both answer -32603 "Internal error" with no data, since a plain error has no RC code, and neither the hostname nor the path reaches the caller
   */
  test("a store failure answers -32603 with no message", async () => {
    const store = new FailingStore();
    h = await acpHarness({ agents: PLAIN, sessionStore: store });
    store.failReads = true;
    store.failCreates = true;

    const answers = await h.connect(async (agent) => ({
      list: await refusalOf(agent.request("session/list", {})),
      open: await refusalOf(
        agent.request("session/new", { cwd: "/work", mcpServers: [] }),
      ),
    }));

    for (const answer of [answers.list, answers.open]) {
      expect(answer.code).toBe(-32603);
      expect(answer.message).toBe("Internal error");
      expect(answer.data).toBeUndefined();
      expect(wireText(answer)).not.toContain(HOST);
      expect(wireText(answer)).not.toContain(PATH);
    }
  });

  /**
   * @case The mount's own refusals and the SDK's parameter checks still reach the caller as written
   * @preconditions A prompt to a session id nobody issued, an image prompt the mount does not accept, and a prompt request missing its required content
   * @expectedResult The unknown session answers -32002 "No such session.", the image answers -32602 naming the content type, and the malformed request answers the SDK's own -32602; none is turned into -32603
   */
  test("deliberate refusals pass through unchanged", async () => {
    h = await acpHarness({ agents: PLAIN });

    const answers = await h.connect(async (agent) => {
      const session = await agent.buildSession("/work").start();
      const result = {
        missing: await refusalOf(
          agent.request("session/prompt", {
            sessionId: "11111111-2222-3333-4444-555555555555",
            prompt: [{ type: "text", text: "anyone there?" }],
          }),
        ),
        image: await refusalOf(
          agent.request("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "image", data: "", mimeType: "image/png" }],
          }),
        ),
        malformed: await refusalOf(
          agent.request("session/prompt", {
            sessionId: session.sessionId,
          } as never),
        ),
      };
      session.dispose();
      return result;
    });

    expect(answers.missing).toMatchObject({
      code: -32002,
      message: "No such session.",
    });
    expect(answers.image.code).toBe(-32602);
    expect(answers.image.message).toContain('does not accept "image"');
    expect(answers.malformed.code).toBe(-32602);
    expect(h.t.contextLogger.error.mock.calls).toHaveLength(0);
  });
});
