import { afterEach, describe, expect, test } from "bun:test";
import {
  CACHE_STORE,
  MemoryCacheProvider,
  MemoryCredentialStore,
  createLogger,
  definePlugin,
  defineProject,
  direct,
  noop,
  pluginTooling,
  scopedCredentialStore,
  step,
  type CredentialLogin,
  type ToolingContext,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";

const OWNER = "acme:warehouse";

const login: CredentialLogin = {
  id: "warehouse",
  owner: OWNER,
  description: "https://warehouse.test",
  async login(store) {
    await store.put(OWNER, { token: "w-1" }, { ifVersion: null });
  },
};

/** One plugin using every extension point a third party is given at once. */
const warehouse = definePlugin({
  id: "acme.warehouse",
  namespace: "warehouse",
  provides: [CACHE_STORE],
  replaces: [CACHE_STORE],
  bind(c) {
    c.provide(CACHE_STORE, new MemoryCacheProvider());
  },
  steps: {
    shelve: (aisle: string) =>
      step<{ readonly sku: string }, { readonly sku: string; aisle: string }>(
        (exchange) => ({ ...exchange.body, aisle }),
      ),
  },
  tooling: {
    logins: () => [login],
    commands: {
      whoami: {
        summary: "Print the token the warehouse login stored",
        async run(_args, context) {
          const held = await (await context.credentials()).get(OWNER);
          return held === undefined
            ? { code: 1, error: "not connected" }
            : { code: 0, output: JSON.stringify(held.value) };
        },
      },
    },
  },
});

describe("outsider: a plugin with tooling, built on the published entry", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  /**
   * @case A tool reads a third-party plugin's commands and logins without starting anything
   * @preconditions A plugin declaring a step, a replaced port, a login and a command, installed by a project; a memory credential store narrowed to the plugin's own owners
   * @expectedResult pluginTooling lists the plugin under its namespace; its command fails before the login ran and prints the stored token after; the narrowed store refuses another owner
   */
  test("its login and command run from the project's plugin list", async () => {
    const project = defineProject({ plugins: [warehouse] });
    const tooling = pluginTooling(project.config).find(
      (each) => each.plugin === "acme.warehouse",
    );
    expect(tooling?.namespace).toBe("warehouse");
    expect(tooling?.logins.map((each) => each.id)).toEqual(["warehouse"]);

    const store = new MemoryCredentialStore();
    const scoped = scopedCredentialStore(
      store,
      new Set([OWNER]),
      "acme.warehouse",
    );
    const context: ToolingContext = {
      root: process.cwd(),
      logger: createLogger({ level: "silent" }),
      credentials: async () => scoped,
    };
    const whoami = tooling!.commands["whoami"]!;

    expect(await whoami.run([], context)).toEqual({
      code: 1,
      error: "not connected",
    });
    await tooling!.logins[0]!.login(scoped, {
      redirectUrl: "http://127.0.0.1/callback",
      openUrl: async () => undefined,
      waitForCallback: async () => new URLSearchParams(),
    });
    expect(await whoami.run([], context)).toEqual({
      code: 0,
      output: '{"token":"w-1"}',
    });
    await expect(scoped.get("acme:elsewhere")).rejects.toMatchObject({
      rc: "RC5070",
    });
  });

  /**
   * @case The same plugin's step and replaced port work in a running application
   * @preconditions The project's craft() builds a route with the plugin's step; the application starts with the plugin's cache store in place of the default
   * @expectedResult The application starts with the replacement installed and the step's result reaches the caller
   */
  test("its step runs on a route of the same project", async () => {
    const project = defineProject({ plugins: [warehouse] });
    const route = project
      .craft()
      .id("stock")
      .from(direct<{ readonly sku: string }>())
      .shelve("A3")
      .to(noop());

    t = await testContext().with(project.config).routes(route).build();
    await t.startAndWaitReady();

    expect(await t.client.sendDirect("stock", { sku: "s-1" })).toEqual({
      sku: "s-1",
      aisle: "A3",
    });
  });
});
