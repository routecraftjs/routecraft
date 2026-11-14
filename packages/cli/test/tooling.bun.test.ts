import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  definePlugin,
  rcCodeOf,
  type CraftConfig,
  type ToolingCommand,
} from "@routecraft/routecraft";

const {
  RESERVED_VERBS,
  SHARED_VERBS,
  VALUED_FLAGS,
  runToolingCommand,
  toolingInvocation,
  toolingOf,
} = await import("../src/tooling");

const echo: ToolingCommand = {
  summary: "Echo",
  run: async () => ({ code: 0 }),
};

async function refusal(config: CraftConfig): Promise<unknown> {
  return toolingOf(config).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("the verb table", () => {
  /**
   * @case Which command lines are a plugin's and which are craft's own
   * @preconditions Lines naming a craft verb, a shipped ops subcommand, a shared verb with a plugin key, a bare shared verb, an unknown word inside and outside a project, and root flags ahead of the verb
   * @expectedResult craft's own lines are undefined; the others give the namespace and key, read past the flags that take a value
   */
  test("reads a plugin command from the words alone", () => {
    expect(toolingInvocation(["run", "file.ts"], true)).toBeUndefined();
    expect(toolingInvocation(["ops", "health"], true)).toBeUndefined();
    expect(toolingInvocation(["ops"], true)).toBeUndefined();
    expect(toolingInvocation(["acp"], true)).toBeUndefined();
    expect(toolingInvocation(["--help"], true)).toBeUndefined();
    expect(
      toolingInvocation(["--version", "mcp", "pin"], true),
    ).toBeUndefined();
    expect(toolingInvocation(["demo", "echo"], false)).toBeUndefined();

    expect(toolingInvocation(["ops", "drain"], false)).toEqual({
      namespace: "ops",
      key: "drain",
    });
    expect(toolingInvocation(["mcp", "pin", "billing"], false)).toEqual({
      namespace: "mcp",
      key: "pin",
    });
    expect(toolingInvocation(["mcp"], false)).toEqual({ namespace: "mcp" });
    expect(toolingInvocation(["demo", "echo"], true)).toEqual({
      namespace: "demo",
      key: "echo",
    });
    expect(
      toolingInvocation(["--log-level", "debug", "--env=.env", "demo"], true),
    ).toEqual({ namespace: "demo" });
    expect(toolingInvocation(["demo", "--flag", "value"], true)).toEqual({
      namespace: "demo",
    });
  });

  /**
   * @case The table names exactly what the command line registers
   * @preconditions The source of index.ts, read for its top-level commands, the subcommands registered under ops, and the valued flags of withLogOptions and withEnvironment
   * @expectedResult Every reserved and shared verb is a registered command, the ops entry lists exactly the ops subcommands, and the flags skipped when reading the verb are exactly the valued ones, so an addition to one place and not the other fails here
   */
  test("matches the commands index.ts registers", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "index.ts"),
      "utf8",
    );
    const registered = [...source.matchAll(/\.command\("([a-z-]+)"/g)].map(
      (match) => match[1]!,
    );
    const ops = Object.keys(SHARED_VERBS).reduce(
      (rest, verb) => rest.filter((name) => name !== verb),
      registered.filter((name) => !RESERVED_VERBS.includes(name)),
    );
    expect([...ops].sort()).toEqual([...SHARED_VERBS["ops"]!.shipped].sort());

    const helpers = source.slice(
      source.indexOf("function withLogOptions"),
      source.indexOf("await registerPluginCommand()"),
    );
    const valued = [
      ...helpers.matchAll(
        /function with(?:LogOptions|Environment)[\s\S]*?\n}\n/g,
      ),
    ].flatMap((match) =>
      [...match[0].matchAll(/"(--[a-z-]+) <[a-z]+>"/g)].map((flag) => flag[1]!),
    );
    expect(valued.sort()).toEqual([...VALUED_FLAGS].sort());
    for (const verb of [...RESERVED_VERBS, ...Object.keys(SHARED_VERBS)]) {
      if (verb === "help") continue;
      expect(registered).toContain(verb);
    }
  });

  /**
   * @case A plugin's commands under a verb craft keeps
   * @preconditions A plugin with the namespace "run" that declares a command, and one with the same namespace that declares none
   * @expectedResult RC1117 naming the plugin and the verb for the first; the second is accepted, since it has nothing to reach
   */
  test("refuses commands under a reserved verb with RC1117", async () => {
    const error = await refusal({
      plugins: [
        definePlugin({
          id: "acme.runner",
          namespace: "run",
          tooling: { commands: { echo } },
        }),
      ],
    });
    expect(rcCodeOf(error)).toBe("RC1117");
    expect((error as Error).message).toMatch(/"acme\.runner".*"run"/);

    expect(
      await refusal({
        plugins: [definePlugin({ id: "acme.runner", namespace: "run" })],
      }),
    ).toBeUndefined();
  });

  /**
   * @case A plugin command named like a subcommand craft ships
   * @preconditions A plugin with the namespace "ops" declaring the command "health", and another declaring "drain"
   * @expectedResult RC1117 naming craft ops health for the first; "drain" is accepted beside the shipped subcommands
   */
  test("refuses a key craft ships under a shared verb with RC1117", async () => {
    const plugin = (key: string) =>
      definePlugin({
        id: "acme.ops",
        namespace: "ops",
        tooling: { commands: { [key]: echo } },
      });
    const error = await refusal({ plugins: [plugin("health")] });
    expect(rcCodeOf(error)).toBe("RC1117");
    expect((error as Error).message).toMatch(/craft ops health/);
    expect(await refusal({ plugins: [plugin("drain")] })).toBeUndefined();
  });

  /**
   * @case A namespace that cannot be typed as one word carries no commands
   * @preconditions A plugin with the explicit namespace "acme tools" declaring a command, and the same plugin declaring none
   * @expectedResult RC1117 naming the namespace for the first, since craft <namespace> could never reach it; the second is accepted
   */
  test("refuses commands under a namespace that is not one word", async () => {
    const error = await refusal({
      plugins: [
        definePlugin({
          id: "acme.tools",
          namespace: "acme tools",
          tooling: { commands: { echo } },
        }),
      ],
    });
    expect(rcCodeOf(error)).toBe("RC1117");
    expect((error as Error).message).toMatch(/namespace "acme tools"/);
    expect(
      await refusal({
        plugins: [definePlugin({ id: "acme.tools", namespace: "acme tools" })],
      }),
    ).toBeUndefined();
  });

  /**
   * @case A third-party plugin taking the namespace of an installed first-party one
   * @preconditions The ops key set, and a listed plugin with its own id and the namespace "ops"
   * @expectedResult RC1102: namespaces are unique per application, so a shared verb has one owner
   */
  test("a second plugin in the ops namespace is RC1102", async () => {
    const error = await refusal({
      ops: {},
      plugins: [
        definePlugin({
          id: "acme.ops",
          namespace: "ops",
          tooling: { commands: { drain: echo } },
        }),
      ],
    });
    expect(rcCodeOf(error)).toBe("RC1102");
  });
});

/**
 * A project with two plugins. `vault` declares a login and commands that
 * read the credential store; `other` declares a login of its own.
 */
const CONFIG = (dbPath: string) => `
import { defineProject, definePlugin } from "@routecraft/routecraft";

const login = (id) => ({ id, owner: "test:" + id, description: id, async login() {} });

const vault = definePlugin({
  id: "test.vault",
  namespace: "mcp",
  tooling: {
    logins: () => [login("mine")],
    commands: {
      echo: {
        summary: "Print the arguments and the project root",
        usage: "[words...]",
        async run(args, context) {
          if (args[0] === "throw") throw new Error("the command failed");
          return { code: args.length, output: JSON.stringify({ args, rootIsCwd: context.root === process.cwd() }) };
        },
      },
      keep: {
        summary: "Write and read this plugin's own credential",
        async run(_args, context) {
          const store = await context.credentials();
          await store.put("test:mine", { token: "t-1" }, { ifVersion: null });
          const held = await store.list();
          return { code: 0, output: held.map((each) => each.owner).join(",") };
        },
      },
      steal: {
        summary: "Read another plugin's credential",
        async run(_args, context) {
          const store = await context.credentials();
          await store.get("test:theirs");
          return { code: 0 };
        },
      },
    },
  },
});

const other = definePlugin({
  id: "test.other",
  tooling: { logins: () => [login("theirs")] },
});

export default defineProject({
  credentials: { store: ${JSON.stringify(dbPath)} },
  plugins: [vault, other],
});
`;

describe("a command a plugin adds to craft", () => {
  let root: string;
  let cwd: string;
  let counter = 0;

  beforeEach(() => {
    counter += 1;
    root = join(import.meta.dir, `tmp-tooling-${Date.now()}-${counter}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "craft.config.ts"),
      CONFIG(join(root, "creds.db")),
    );
    cwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * @case A plugin's command runs under a verb craft shares with it
   * @preconditions A plugin in the "mcp" namespace declaring "echo"; the command is run with one argument
   * @expectedResult The command's own result comes back: its exit code, and output showing the arguments and the project root
   */
  test("runs the command with its arguments and the project root", async () => {
    const result = await runToolingCommand("mcp", "echo", ["books"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output ?? "")).toEqual({
      args: ["books"],
      rootIsCwd: true,
    });
  });

  /**
   * @case Help and listings come from the plugin's own summary and usage
   * @preconditions The namespace with no key, the command with --help, and a key the plugin does not declare
   * @expectedResult The namespace lists its commands and exits 1 (0 with --help); the command's help shows its usage line and summary without running it; --help after another argument reaches the command as its own; the unknown key is refused with the listing
   */
  test("lists the commands and prints a command's help", async () => {
    const bare = await runToolingCommand("mcp", undefined, []);
    expect(bare.code).toBe(1);
    expect(bare.output).toContain(
      "  craft mcp echo [words...]  Print the arguments and the project root",
    );
    expect((await runToolingCommand("mcp", undefined, ["--help"])).code).toBe(
      0,
    );

    expect(await runToolingCommand("mcp", "echo", ["--help"])).toEqual({
      code: 0,
      output:
        "Usage: craft mcp echo [words...]\n\nPrint the arguments and the project root",
    });

    const forwarded = await runToolingCommand("mcp", "echo", ["-x", "--help"]);
    expect(JSON.parse(forwarded.output ?? "")).toMatchObject({
      args: ["-x", "--help"],
    });

    const unknown = await runToolingCommand("mcp", "nothing", []);
    expect(unknown.code).toBe(1);
    expect(unknown.error).toContain(
      'Plugin "test.vault" declares no command "nothing".',
    );
  });

  /**
   * @case The ways a command cannot run
   * @preconditions A command that throws; a namespace no installed plugin declares commands under; a directory with no config
   * @expectedResult Exit 1 each time: the thrown message, the namespace named with the commands that do exist, and the missing config file named
   */
  test("reports a throw, an unknown namespace and a missing config", async () => {
    expect(await runToolingCommand("mcp", "echo", ["throw"])).toEqual({
      code: 1,
      error: "the command failed",
    });

    const missing = await runToolingCommand("demo", "echo", []);
    expect(missing.code).toBe(1);
    expect(missing.error).toContain('"demo" is not a craft command');
    expect(missing.error).toContain("craft mcp echo");

    rmSync(join(root, "craft.config.ts"));
    const none = await runToolingCommand("mcp", "echo", []);
    expect(none.code).toBe(1);
    expect(none.error).toContain("No craft.config.ts found");
  });

  /**
   * @case A command reaches its own plugin's credentials and no other's
   * @preconditions Two plugins, each declaring one login; the first plugin's commands write and list the store, then read the second plugin's owner
   * @expectedResult The write succeeds and the listing shows only the plugin's own owner; reading the other owner fails the command, naming the plugin and the owner it may not reach
   */
  test("hands a command only its own plugin's credentials", async () => {
    const kept = await runToolingCommand("mcp", "keep", []);
    expect(kept).toEqual({ code: 0, output: "test:mine" });

    const stolen = await runToolingCommand("mcp", "steal", []);
    expect(stolen.code).toBe(1);
    expect(stolen.error).toMatch(/"test\.vault".*"test:theirs"/);
  });
});
