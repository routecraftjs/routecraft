/**
 * `acp:` on `defineConfig`, the first-party way to serve the protocol.
 *
 * The key has to serve the agents the `agent` key registered whichever of
 * the two is written first, which config appliers give it: they apply in
 * registration order, not key order, and `acp` registers last. Each case
 * boots a real instance and speaks the protocol to it over a real socket.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  mock,
  test,
} from "bun:test";
import {
  MemoryDeferralStore,
  defineConfig,
  type CraftConfig,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { acpPlugin, agentPlugin } from "../src/index.ts";
import type { AcpPluginOptions } from "../src/acp/types.ts";
import { connectAcp } from "./helpers/acp-harness.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

const AGENTS = {
  max: {
    description: "Max",
    model: MODEL,
    system: "be useful",
  },
};

/**
 * Boot a context from `config`, speak the handshake to the mount at `path`,
 * and answer with what `initialize` returned.
 */
async function serve(
  config: CraftConfig,
  path = "/acp",
): Promise<{
  t: TestContext;
  agentInfo: { name?: string } | null | undefined;
}> {
  let port = 0;
  const t = await testContext()
    .on("server:listening", ({ details }) => {
      port = details.port;
    })
    .with(config)
    .build();
  await t.startAndWaitReady();
  const agentInfo = await connectAcp(
    `http://127.0.0.1:${port}${path}`,
    (_agent, initialized) => Promise.resolve(initialized.agentInfo),
  );
  return { t, agentInfo };
}

describe("the acp config key", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case The key serves the protocol with the agents written under `agent`, written after it
   * @preconditions defineConfig with `acp` before `agent` in the object, a named server, memory stores
   * @expectedResult The instance boots and answers initialize as Routecraft: the key applied after `agent` whatever the key order
   */
  test("acp written before agent boots and serves the protocol", async () => {
    const served = await serve({
      acp: {},
      servers: { default: { host: "127.0.0.1", port: 0 } },
      deferral: { store: new MemoryDeferralStore() },
      sessions: { store: "memory" },
      agent: { agents: AGENTS },
    });
    t = served.t;
    expect(served.agentInfo?.name).toBe("routecraft");
  });

  /**
   * @case The key takes the factory's options
   * @preconditions `acp` with a custom path and agentInfo, agent written first
   * @expectedResult The mount answers on that path as the configured name, so the key and the factory are one option set
   */
  test("acp carries the factory's options", async () => {
    const served = await serve(
      {
        agent: { agents: AGENTS },
        servers: { default: { host: "127.0.0.1", port: 0 } },
        deferral: { store: new MemoryDeferralStore() },
        sessions: { store: "memory" },
        acp: { path: "/editor", agentInfo: { name: "eywa", version: "1" } },
      },
      "/editor",
    );
    t = served.t;
    expect(served.agentInfo?.name).toBe("eywa");
  });

  /**
   * @case The plugins form serves whichever order the plugins are listed in
   * @preconditions `plugins: [acpPlugin(), agentPlugin({ agents })]`, no `acp` key, the model scripted to answer one turn
   * @expectedResult The instance boots, serves the protocol and runs a turn on the agent registered after it: every agent contribution binds before ACP reads the registry, so list order carries no constraint
   */
  test("plugins: [acpPlugin(), agentPlugin()] serves, and the agent takes a turn", async () => {
    llm.script.push({ text: "done" });
    let port = 0;
    t = await testContext()
      .on("server:listening", ({ details }) => {
        port = details.port;
      })
      .with({
        servers: { default: { host: "127.0.0.1", port: 0 } },
        llm: { providers: { anthropic: { apiKey: "sk-test" } } },
        deferral: { store: new MemoryDeferralStore() },
        sessions: { store: "memory" },
        plugins: [acpPlugin(), agentPlugin({ agents: AGENTS })],
      })
      .build();
    await t.startAndWaitReady();

    const turn = await connectAcp(
      `http://127.0.0.1:${port}/acp`,
      (agent, initialized) =>
        agent.buildSession("/work").withSession(async (session) => ({
          agentInfo: initialized.agentInfo,
          stopReason: (await session.prompt("go")).stopReason,
        })),
    );
    expect(turn.agentInfo?.name).toBe("routecraft");
    expect(turn.stopReason).toBe("end_turn");
    expect(llm.calls).toHaveLength(1);
  });

  /**
   * @case The key sees agents registered through plugins
   * @preconditions `acp: {}` with the agents in `plugins: [agentPlugin()]` and nothing under `agent`
   * @expectedResult The instance boots and serves them. Config keys apply before listed plugins, so this was once refused with an empty registry
   */
  test("acp serves agents registered only through plugins", async () => {
    const served = await serve({
      acp: {},
      servers: { default: { host: "127.0.0.1", port: 0 } },
      deferral: { store: new MemoryDeferralStore() },
      sessions: { store: "memory" },
      plugins: [agentPlugin({ agents: AGENTS })],
    });
    t = served.t;
    expect(served.agentInfo?.name).toBe("routecraft");
  });

  /**
   * @case ACP with no agents at all
   * @preconditions `acp: {}` and no agent registered anywhere
   * @expectedResult The build fails with RC5003 naming every way to register one
   */
  test("acp with no agents is refused naming the fix", async () => {
    await expect(
      testContext()
        .with({
          acp: {},
          servers: { default: { host: "127.0.0.1", port: 0 } },
          deferral: { store: new MemoryDeferralStore() },
          sessions: { store: "memory" },
        })
        .build(),
    ).rejects.toMatchObject({
      rc: "RC5003",
      message: expect.stringContaining("Write the agents under `agent:`"),
    });
  });

  /**
   * @case The key is typed as the factory's options
   * @preconditions defineConfig with an `acp` value
   * @expectedResult `cfg.acp` is an AcpPluginOptions, so an option the factory does not take is a compile error here too
   */
  test("acp is typed as AcpPluginOptions", () => {
    const cfg = defineConfig({
      acp: { path: "/acp", toolCallPayloads: false },
    });
    expectTypeOf(cfg.acp).toEqualTypeOf<AcpPluginOptions | undefined>();

    defineConfig({
      // @ts-expect-error port belongs to servers, not to the acp options
      acp: { path: "/acp", port: 8080 },
    });
  });
});
