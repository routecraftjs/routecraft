import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDeferralStore } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { acpPlugin, AGENTS, agentPlugin, llmPlugin } from "../src/index.ts";
import {
  MemorySessionStore,
  SESSION_STORE,
} from "../src/agent/session/index.ts";
import { createSessionStore } from "../src/agent/session/config.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";

const scratch = mkdtempSync(join(tmpdir(), "rc-agent-ports-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const llm = () =>
  llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } });

/**
 * One agent runtime, fed by any number of `agentPlugin()` contributions, and
 * reached by other plugins and adapters through ports rather than store keys.
 */
describe("the agent runtime and its ports", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Two agentPlugin installs share one runtime
   * @preconditions plugins: [agentPlugin({ agents }), agentPlugin({ agents })] and nothing else agent-related
   * @expectedResult The runtime and the default sessions plugin bind once, the contributions bind as #1 and #2, and the AGENTS registry holds both agents
   */
  test("composes every install into one runtime", async () => {
    const bound: string[] = [];
    t = await testContext()
      .on("plugin:bound", ({ details }) => {
        bound.push(details.pluginId);
      })
      .with({
        deferral: { store: new MemoryDeferralStore() },
        plugins: [
          llm(),
          agentPlugin({
            agents: { a: { description: "A", model: MODEL, system: "x" } },
          }),
          agentPlugin({
            agents: { b: { description: "B", model: MODEL, system: "x" } },
          }),
        ],
      })
      .build();

    expect(bound.filter((id) => id.startsWith("routecraft.ai."))).toEqual([
      "routecraft.ai.llm",
      "routecraft.ai.sessions",
      "routecraft.ai.agent",
      "routecraft.ai.agent.contribution#1",
      "routecraft.ai.agent.contribution#2",
    ]);
    expect([...t.ctx.require(AGENTS).agents.keys()]).toEqual(["a", "b"]);
  });

  /**
   * @case The agent config key and an agentPlugin in plugins compose
   * @preconditions agent: { agents: { a } } in config and agentPlugin({ agents: { b } }) in plugins
   * @expectedResult Both agents are registered with the one runtime
   */
  test("composes the config key with a listed install", async () => {
    t = await testContext()
      .with({
        agent: {
          agents: { a: { description: "A", model: MODEL, system: "x" } },
        },
        plugins: [
          llm(),
          agentPlugin({
            agents: { b: { description: "B", model: MODEL, system: "x" } },
          }),
        ],
      })
      .build();
    expect([...t.ctx.require(AGENTS).agents.keys()].sort()).toEqual(["a", "b"]);
  });

  /**
   * @case A contribution after the application started
   * @preconditions A started context, then a direct call to contribute() on the AGENTS registry
   * @expectedResult RC1110, and the registry is unchanged
   */
  test("refuses a contribution once the application started", async () => {
    t = await testContext()
      .with({
        plugins: [
          llm(),
          agentPlugin({
            agents: { a: { description: "A", model: MODEL, system: "x" } },
          }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    const registry = t.ctx.require(AGENTS);
    expect(() =>
      registry.contribute({
        agents: { late: { description: "L", model: MODEL, system: "x" } },
      }),
    ).toThrow(expect.objectContaining({ rc: "RC1110" }));
    expect(registry.agents.has("late")).toBe(false);
  });

  /**
   * @case The continuations store and the session store configured onto one file through their config keys
   * @preconditions deferral: { store: { path } } and sessions: { store: { path } } with the same path, plus an agentPlugin
   * @expectedResult The build fails with AI1012 naming both settings and the path: the sessions plugin reads where the continuations store opened through the CONTINUATIONS port
   */
  test("refuses a session store sharing the continuations store's file", async () => {
    const path = join(scratch, "shared.db");
    const failure = await testContext()
      .with({
        deferral: { store: { path } },
        sessions: { store: { path } },
        plugins: [
          llm(),
          agentPlugin({
            agents: { a: { description: "A", model: MODEL, system: "x" } },
          }),
        ],
      })
      .build()
      .then(
        () => undefined,
        (err: Error) => err,
      );
    expect(failure).toMatchObject({ rc: "AI1012" });
    expect(failure!.message).toContain("sessions: { store }");
    expect(failure!.message).toContain("deferral: { store }");
    expect(failure!.message).toContain(path);
  });

  /**
   * @case The sessions key's store is the one the agent runtime holds its conversations in
   * @preconditions sessions: { store } with a caller-supplied backend, a deferral block, and an agentPlugin
   * @expectedResult SESSION_STORE answers the supplied backend, and the AGENTS session runtime writes through it
   */
  test("runs sessions on the store the sessions key chose", async () => {
    const own = new MemorySessionStore();
    t = await testContext()
      .with({
        deferral: { store: new MemoryDeferralStore() },
        sessions: { store: own },
        plugins: [
          llm(),
          agentPlugin({
            agents: { a: { description: "A", model: MODEL, system: "x" } },
          }),
        ],
      })
      .build();
    expect(t.ctx.require(SESSION_STORE).store).toBe(own);
    await t.ctx.require(AGENTS).sessions().open("s1", "a", { owner: null });
    expect(await own.keys()).toEqual(["s1"]);
  });

  /**
   * @case ACP installed with no agent runtime at all
   * @preconditions acpPlugin() in plugins, no agentPlugin and no agent key
   * @expectedResult The build fails with RC1104 naming the AGENTS port, before anything binds
   */
  test("ACP requires the agents port", async () => {
    await expect(
      testContext()
        .with({
          servers: { default: { host: "127.0.0.1", port: 0 } },
          plugins: [acpPlugin()],
        })
        .build(),
    ).rejects.toMatchObject({
      rc: "RC1104",
      message: expect.stringContaining("routecraft.ai.agents@1"),
    });
  });
});

/**
 * A resolved session store releases its file only after every session
 * runtime writing to it has stopped.
 */
describe("the resolved session store", () => {
  /**
   * @case Closing a store with a retained writer
   * @preconditions A memory store resolved for a context, a writer retained on it, and the store's own close recorded
   * @expectedResult The writer stops before the store closes, and a second close does neither again
   */
  test("stops retained writers before it closes", async () => {
    const t = await testContext().build();
    try {
      const resolved = await createSessionStore(t.ctx, { store: "memory" });
      const order: string[] = [];
      const store = resolved.store as MemorySessionStore;
      const close = store.close.bind(store);
      store.close = async () => {
        order.push("store");
        await close();
      };
      resolved.retain({
        async stop() {
          order.push("writer");
        },
      });
      await resolved.close();
      await resolved.close();
      expect(order).toEqual(["writer", "store"]);
    } finally {
      await t.stop();
    }
  });
});
