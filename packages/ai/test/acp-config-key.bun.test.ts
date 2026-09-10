/**
 * `acp:` on `defineConfig`, the first-party way to serve the protocol.
 *
 * The key has to serve the agents the `agent` key registered whichever of
 * the two is written first, which config appliers give it: they apply in
 * registration order, not key order, and `acp` registers last. Each case
 * boots a real instance and speaks the protocol to it over a real socket.
 */

import { afterEach, describe, expect, expectTypeOf, test } from "bun:test";
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

const AGENTS = {
  max: {
    description: "Max",
    model: MODEL,
    system: "be useful",
    user: (ex: { body: unknown }) => (ex.body as { message: string }).message,
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
   * @case The plugins form keeps working with its ordering constraint
   * @preconditions `plugins: [agentPlugin({ agents }), acpPlugin()]`, no `acp` key
   * @expectedResult The instance boots and serves the protocol exactly as before the key existed
   */
  test("plugins: [agentPlugin(), acpPlugin()] still serves", async () => {
    const served = await serve({
      servers: { default: { host: "127.0.0.1", port: 0 } },
      deferral: { store: new MemoryDeferralStore() },
      sessions: { store: "memory" },
      plugins: [agentPlugin({ agents: AGENTS }), acpPlugin()],
    });
    t = served.t;
    expect(served.agentInfo?.name).toBe("routecraft");
  });

  /**
   * @case Agents registered only through plugins are not visible to the key, and the refusal says where to put them
   * @preconditions `acp: {}` with the agents in `plugins: [agentPlugin()]` and nothing under `agent`
   * @expectedResult The build fails with RC5003 naming both forms, because keys apply before plugins and the registry is empty when acp applies
   */
  test("acp with agents only in plugins is refused naming the fix", async () => {
    await expect(
      testContext()
        .with({
          acp: {},
          servers: { default: { host: "127.0.0.1", port: 0 } },
          deferral: { store: new MemoryDeferralStore() },
          sessions: { store: "memory" },
          plugins: [agentPlugin({ agents: AGENTS })],
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
    expectTypeOf(cfg.acp).toMatchTypeOf<AcpPluginOptions>();
  });
});
