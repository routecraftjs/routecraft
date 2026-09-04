import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  MemorySuspensionStore,
  craft,
  direct,
  noop,
  opsPlugin,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  agent,
  agentPlugin,
  llmPlugin,
  type AgentSessionSummary,
} from "../src/index.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/suspend-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const ChatMessage = z.object({ session: z.string(), message: z.string() });
type ChatMessage = z.infer<typeof ChatMessage>;

async function get<T>(
  port: number,
  path: string,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : undefined) as T,
  };
}

describe("the agent-sessions management resource", () => {
  let t: TestContext | undefined;

  beforeEach(() => llm.reset());

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  async function start(withStore: boolean): Promise<number> {
    t = await testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        ...(withStore
          ? { suspension: { store: new MemorySuspensionStore() } }
          : {}),
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            agents: {
              max: {
                description: "Max",
                model: MODEL,
                system: "x",
                user: (ex) => (ex.body as { message: string }).message,
              },
            },
          }),
          opsPlugin({ tiers: { introspection: true } }),
        ],
      })
      .routes([
        craft()
          .id("chat")
          .input({ body: ChatMessage })
          .from(direct())
          .to(agent<ChatMessage>("max", { session: (ex) => ex.body.session }))
          .to(noop()),
      ])
      .build();
    let port: number | undefined;
    t.ctx.on("server:listening", ({ details }) => {
      port = details.port;
    });
    await t.startAndWaitReady();
    if (port === undefined) throw new Error("no server reported a port");
    return port;
  }

  /**
   * @case Sessions are listable with their inbox depth, and one is readable by agent and id
   * @preconditions Two sessions have each had one turn; the introspection tier is open
   * @expectedResult GET /ops/agent-sessions lists both with turn idle, inbox 0 and turns 1; ?agent= filters; GET /ops/agent-sessions/max/s1 answers the one summary; an unknown session answers 404
   */
  test("lists and describes sessions", async () => {
    const port = await start(true);
    llm.script.push({ text: "a" }, { text: "b" });
    await t!.client.sendDirect("chat", { session: "s1", message: "hi" });
    await t!.client.sendDirect("chat", { session: "s2", message: "hi" });

    const list = await get<{ items: AgentSessionSummary[] }>(
      port,
      "/ops/agent-sessions",
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((s) => s.session).sort()).toEqual(["s1", "s2"]);
    expect(list.body.items[0]).toMatchObject({
      agent: "max",
      turn: "idle",
      inbox: 0,
      background: 0,
      messages: 2,
      turns: 1,
    });
    const filtered = await get<{ items: AgentSessionSummary[] }>(
      port,
      "/ops/agent-sessions?agent=other",
    );
    expect(filtered.body.items).toHaveLength(0);

    const one = await get<AgentSessionSummary>(
      port,
      "/ops/agent-sessions/max/s1",
    );
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ agent: "max", session: "s1", turns: 1 });
    expect((await get(port, "/ops/agent-sessions/max/nope")).status).toBe(404);
    expect((await get(port, "/ops/agent-sessions/max")).status).toBe(404);
  });

  /**
   * @case The collection pages by keyset cursor, bound to the agent filter
   * @preconditions Three sessions have each had one turn; the introspection tier is open
   * @expectedResult limit=2 answers two items and a nextCursor; the cursor answers the third with no cursor; the same cursor under another agent filter is refused as a 400, as is a limit that is not a positive integer
   */
  test("pages the collection", async () => {
    const port = await start(true);
    llm.script.push({ text: "a" }, { text: "b" }, { text: "c" });
    for (const session of ["s1", "s2", "s3"]) {
      await t!.client.sendDirect("chat", { session, message: "hi" });
    }
    const first = await get<{
      items: AgentSessionSummary[];
      nextCursor?: string;
    }>(port, "/ops/agent-sessions?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.items.map((s) => s.session)).toEqual(["s1", "s2"]);
    expect(typeof first.body.nextCursor).toBe("string");
    const cursor = encodeURIComponent(first.body.nextCursor!);
    const second = await get<{
      items: AgentSessionSummary[];
      nextCursor?: string;
    }>(port, `/ops/agent-sessions?limit=2&after=${cursor}`);
    expect(second.body.items.map((s) => s.session)).toEqual(["s3"]);
    expect(second.body.nextCursor).toBeUndefined();
    expect(
      (await get(port, `/ops/agent-sessions?agent=other&after=${cursor}`))
        .status,
    ).toBe(400);
    expect((await get(port, "/ops/agent-sessions?limit=0")).status).toBe(400);
  });

  /**
   * @case A context without a suspension store lists no sessions rather than failing the read
   * @preconditions No suspension block; the resource is registered by agentPlugin regardless
   * @expectedResult GET /ops/agent-sessions answers 200 with an empty items array
   */
  test("answers an empty collection without a store", async () => {
    const port = await start(false);
    const list = await get<{ items: unknown[] }>(port, "/ops/agent-sessions");
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);
  });
});
