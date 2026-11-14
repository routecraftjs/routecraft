import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  defineProject,
  definePlugin,
  direct,
  installedPluginIds,
  MemoryCredentialStore,
  noop,
  pluginTooling,
  projectOf,
  scopedCredentialStore,
  simple,
  telemetryPlugin,
  type CredentialLogin,
  type ToolingCommand,
} from "../src/index.ts";
import { PluginHost } from "../src/kernel/host.ts";
import { requireContinuations } from "../src/kernel/continuation/port.ts";
import { getErrorMeta } from "../src/error.ts";
import { rcCodeOf } from "../src/brand.ts";

const echo: ToolingCommand = {
  summary: "Say the arguments back",
  usage: "[word...]",
  run: async (args) => ({ code: 0, output: args.join(" ") }),
};

function login(id: string, owner = `acme:${id}`): CredentialLogin {
  return { id, owner, description: `the ${id} account`, login: async () => {} };
}

/**
 * `Plugin.tooling`: what a plugin gives the command line, read off the
 * resolved plugin list without binding anything.
 */
describe("plugin tooling", () => {
  /**
   * @case A configuration's tooling is read from its resolved plugin list
   * @preconditions Two listed plugins, one with a command and a login and one with neither, beside the defaults
   * @expectedResult One entry, for the plugin that declares tooling, carrying its install id, its namespace, its command and its login; no plugin's bind ran
   */
  test("reads commands and logins without binding", () => {
    let bound = false;
    const tooling = pluginTooling({
      plugins: [
        definePlugin({
          id: "acme.reports",
          tooling: { commands: { echo }, logins: () => [login("books")] },
          bind() {
            bound = true;
          },
        }),
        definePlugin({ id: "acme.quiet" }),
      ],
    });
    expect(tooling).toHaveLength(1);
    expect(tooling[0]).toMatchObject({
      plugin: "acme.reports",
      namespace: "reports",
      commands: { echo },
      logins: [{ id: "books", owner: "acme:books" }],
    });
    expect(bound).toBe(false);
  });

  /**
   * @case A plugin brought through installs contributes its tooling too
   * @preconditions A listed plugin that installs a second plugin declaring a command
   * @expectedResult The brought plugin's entry is present under its own namespace
   */
  test("includes a brought plugin", () => {
    const runtime = definePlugin({
      id: "acme.runtime",
      tooling: { commands: { echo } },
    });
    const tooling = pluginTooling({
      plugins: [definePlugin({ id: "acme.feature", installs: [runtime] })],
    });
    expect(tooling.map((each) => each.namespace)).toEqual(["runtime"]);
  });

  /**
   * @case Two plugins that claim one namespace are refused before any tooling is read
   * @preconditions Plugins "acme.ops" and "other.ops", both defaulting to the namespace "ops", each with a command
   * @expectedResult RC1102 naming both plugins, the same fault the application raises for the list
   */
  test("a shared namespace is RC1102", () => {
    expect(() =>
      pluginTooling({
        plugins: [
          definePlugin({ id: "acme.ops", tooling: { commands: { echo } } }),
          definePlugin({ id: "other.ops", tooling: { commands: { echo } } }),
        ],
      }),
    ).toThrow(expect.objectContaining({ rc: "RC1102" }));
  });

  /**
   * @case Two logins with one id, or one store owner, across plugins
   * @preconditions Two plugins each declaring a login named "mail"; then two declaring different names kept under one owner
   * @expectedResult RC5003 naming the id, then the owner
   */
  test("a duplicate login id or owner is RC5003", () => {
    const withLogin = (id: string, declared: CredentialLogin) =>
      definePlugin({ id, tooling: { logins: () => [declared] } });
    expect(() =>
      pluginTooling({
        plugins: [
          withLogin("a.one", login("mail", "a:mail")),
          withLogin("b.two", login("mail", "b:mail")),
        ],
      }),
    ).toThrow(expect.objectContaining({ rc: "RC5003" }));
    expect(() =>
      pluginTooling({
        plugins: [
          withLogin("a.one", login("mail", "a:mail")),
          withLogin("b.two", login("post", "a:mail")),
        ],
      }),
    ).toThrow(/"a:mail"/);
  });

  /**
   * @case Every wrong shape of tooling is an invalid descriptor
   * @preconditions Descriptors whose tooling is not an object, whose logins is not a function, whose commands is not an object, whose command key holds a space, whose command lacks run or summary or has a usage that is not a string, whose namespace is not a string, a repeatable plugin with a command, and logins that return nothing, a sparse array or something other than logins
   * @expectedResult RC1117 for each, raised when the plugin list is resolved (the last when the logins are read)
   */
  test("a malformed tooling is RC1117", () => {
    const invalid: unknown[] = [
      { id: "x.a", tooling: "pin" },
      { id: "x.b", tooling: { logins: [] } },
      { id: "x.c", tooling: { commands: [] as unknown } },
      { id: "x.d", tooling: { commands: { "two words": echo } } },
      { id: "x.e", tooling: { commands: { pin: { summary: "no run" } } } },
      { id: "x.f", tooling: { commands: { pin: { run: echo.run } } } },
      { id: "x.g", repeatable: true, tooling: { commands: { echo } } },
      { id: "x.i", tooling: { commands: { pin: { ...echo, usage: 3 } } } },
      { id: "x.j", namespace: 5, tooling: { commands: { echo } } },
    ];
    for (const plugin of invalid) {
      expect(() => new PluginHost([plugin])).toThrow(
        expect.objectContaining({ rc: "RC1117" }),
      );
    }
    for (const logins of [[{ id: "mail" }], null, new Array<unknown>(1)]) {
      expect(() =>
        pluginTooling({
          plugins: [
            definePlugin({
              id: "x.h",
              tooling: { logins: () => logins as never },
            }),
          ],
        }),
      ).toThrow(expect.objectContaining({ rc: "RC1117" }));
    }
  });

  /**
   * @case A scoped credential store reaches only the owners it was given
   * @preconditions A store holding "acme:books" and "other:mail", viewed through a scope of "acme:books" alone
   * @expectedResult The scoped owner reads, writes and deletes; the other owner is refused with RC5070 on get, put and delete, and is absent from the listing; closing the view leaves the store open
   */
  test("a scoped store refuses another plugin's credential", async () => {
    const store = new MemoryCredentialStore();
    await store.put("acme:books", { token: "a" }, { ifVersion: null });
    await store.put("other:mail", { token: "b" }, { ifVersion: null });
    const scoped = scopedCredentialStore(
      store,
      new Set(["acme:books"]),
      "acme.reports",
    );

    expect((await scoped.get("acme:books"))?.value).toEqual({ token: "a" });
    expect((await scoped.list()).map((held) => held.owner)).toEqual([
      "acme:books",
    ]);
    const refused = expect.objectContaining({
      rc: "RC5072",
      message: expect.stringContaining('"other:mail"'),
    });
    await expect(scoped.get("other:mail")).rejects.toEqual(refused);
    await expect(
      scoped.put("other:mail", {}, { ifVersion: null }),
    ).rejects.toEqual(refused);
    await expect(scoped.delete("other:mail")).rejects.toEqual(refused);

    await scoped.close();
    expect((await store.get("other:mail"))?.value).toEqual({ token: "b" });
    expect(await scoped.delete("acme:books")).toBe(true);
  });
});

/**
 * What a tool needs to run a route in its project: the project a route was
 * built with, and the plugin ids a configuration installs.
 */
describe("a route's project", () => {
  /**
   * @case A route names the project whose craft() started it
   * @preconditions One route from a project's craft(), carried through the whole chain; one from the root craft(); a built definition; a non-route
   * @expectedResult The project for the first, undefined for the others
   */
  test("projectOf finds the project of a project.craft() route", () => {
    const project = defineProject({ plugins: [] });
    const route = project.craft().id("mine").from(simple("x")).to(noop());
    expect(projectOf(route)).toBe(project);
    expect(projectOf(craft().id("root").from(simple("x")))).toBeUndefined();
    expect(projectOf(route.build()[0])).toBeUndefined();
    expect(projectOf("route")).toBeUndefined();
  });

  /**
   * @case The installed ids of a configuration include defaults, config keys and brought plugins
   * @preconditions A configuration with the deferral key and a listed plugin that installs another
   * @expectedResult The ids hold the listed plugin, the brought one, routecraft.deferral and a default such as routecraft.direct
   */
  test("installedPluginIds resolves the list the application installs", () => {
    const brought = definePlugin({ id: "acme.runtime" });
    const ids = installedPluginIds({
      deferral: { store: "memory" },
      plugins: [definePlugin({ id: "acme.feature", installs: [brought] })],
    });
    expect(ids).toEqual(
      expect.arrayContaining([
        "acme.feature",
        "acme.runtime",
        "routecraft.deferral",
        "routecraft.direct",
      ]),
    );
  });
});

/** The remedies that used to name defineConfig, and the one RC1111 lacked. */
describe("deferral remedies", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  /**
   * @case A route reads ex.deferral in an application without the deferral runtime
   * @preconditions A root craft() route whose process step reads the deferral facet, in a context that configures no deferral
   * @expectedResult The read is refused with RC1111 whose message names deferral: {} and defineProject, not just "install the plugin"
   */
  test("RC1111 names deferral: {} when the deferral runtime is missing", async () => {
    let refusal: unknown;
    const route = craft()
      .id("reads")
      .from(direct())
      .process((ex) => {
        try {
          void (ex as unknown as { deferral: unknown }).deferral;
        } catch (error) {
          refusal = error;
        }
        return ex;
      })
      .to(noop());
    t = await testContext().routes(route).build();
    await t.startAndWaitReady();
    await t.client.sendDirect("reads", {});
    expect(refusal).toMatchObject({
      rc: "RC1111",
      message: expect.stringMatching(
        /ex\.deferral was read.*deferral: \{\} to defineProject/,
      ),
    });
  });

  /**
   * @case The missing-runtime refusal and RC5052's own suggestion name the entry that exists
   * @preconditions requireContinuations() called with no application; the RC5052 metadata
   * @expectedResult Both say defineProject and neither says defineConfig
   */
  test("RC5052 names defineProject", () => {
    let error: unknown;
    try {
      requireContinuations(undefined, "A resume was asked for");
    } catch (thrown) {
      error = thrown;
    }
    expect(rcCodeOf(error)).toBe("RC5052");
    const message = (error as Error).message;
    expect(message).toContain("deferral: {} to defineProject");
    expect(message).not.toContain("defineConfig");
    const { suggestion } = getErrorMeta("RC5052");
    expect(suggestion).toContain("`defineProject`");
    expect(suggestion).not.toContain("defineConfig");
  });
});

/** One telemetry descriptor holds no state of its own. */
describe("telemetryPlugin in two applications", () => {
  const scratch = mkdtempSync(join(tmpdir(), "rc-telemetry-two-"));
  const contexts: TestContext[] = [];

  afterEach(async () => {
    for (const each of contexts.splice(0)) await each.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  function routeIds(path: string): string[] {
    const db = new Database(path, { readonly: true });
    try {
      return (
        db.query("SELECT id FROM routes ORDER BY id").all() as { id: string }[]
      ).map((row) => row.id);
    } finally {
      db.close();
    }
  }

  /**
   * @case Two applications with two SQLite paths keep their records apart
   * @preconditions Two contexts, each with its own telemetryPlugin({ sqlite: { dbPath } }) and one route of its own, both run to completion and stopped
   * @expectedResult Each database holds its own route and not the other's
   */
  test("two descriptors write to their own databases", async () => {
    const paths = [join(scratch, "a.db"), join(scratch, "b.db")];
    for (const [index, dbPath] of paths.entries()) {
      const t = await testContext()
        .with({ plugins: [telemetryPlugin({ sqlite: { dbPath } })] })
        .routes(craft().id(`route-${index}`).from(simple("x")).to(noop()))
        .build();
      contexts.push(t);
      await t.ctx.start();
    }
    for (const each of contexts.splice(0)) await each.stop();
    expect(routeIds(paths[0]!)).toEqual(["route-0"]);
    expect(routeIds(paths[1]!)).toEqual(["route-1"]);
  });

  /**
   * @case One descriptor shared by two running applications holds each one's state apart
   * @preconditions A single telemetryPlugin() descriptor with SQLite disabled and a recording tracer, listed by two contexts that are both started; the first is stopped while the second still runs
   * @expectedResult Stopping the first ends only its own route span; the second application's span ends when it stops
   */
  test("one descriptor keeps two applications' spans apart", async () => {
    const ended: string[] = [];
    const tracerProvider = {
      getTracer: () => ({
        startSpan: (name: string) => ({
          addEvent() {},
          setAttribute() {},
          setStatus() {},
          spanContext: () => ({ traceId: "0", spanId: "0", traceFlags: 0 }),
          end: () => ended.push(name),
        }),
      }),
    };
    const shared = telemetryPlugin({
      disableSqlite: true,
      tracerProvider: tracerProvider as never,
    });
    for (const id of ["first", "second"]) {
      const t = await testContext()
        .with({ plugins: [shared] })
        .routes(craft().id(id).from(direct()).to(noop()))
        .build();
      contexts.push(t);
      await t.startAndWaitReady();
    }
    await contexts[0]!.stop();
    expect(ended).toEqual(["route:first"]);
    await contexts[1]!.stop();
    expect(ended).toEqual(["route:first", "route:second"]);
    contexts.length = 0;
  });
});
