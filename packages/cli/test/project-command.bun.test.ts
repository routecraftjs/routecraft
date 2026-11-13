import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { runProjectCommand } = await import("../src/project-command");

/**
 * A project whose config registers a command, `demo echo`, the way an
 * ecosystem package registers one when it is imported.
 */
const CONFIG = `
import { registerProjectCommand } from "@routecraft/routecraft";

registerProjectCommand("demo echo", async (config, io) => {
  if (io.args[0] === "throw") throw new Error("the command failed");
  return {
    code: io.args.length,
    output: JSON.stringify({ args: io.args, marker: config.marker, rootIsCwd: io.root === process.cwd() }),
  };
});

export const craftConfig = { marker: "from-config" };
`;

describe("a command an ecosystem package contributes to craft", () => {
  let root: string;
  let cwd: string;
  let counter = 0;

  beforeEach(() => {
    counter += 1;
    root = join(
      import.meta.dir,
      `tmp-project-command-${Date.now()}-${counter}`,
    );
    mkdirSync(root, { recursive: true });
    cwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * @case A registered command runs against the project's loaded config
   * @preconditions A config that registers "demo echo" and carries a marker; the command is run with one argument
   * @expectedResult The command's own result comes back: its exit code, and output showing the arguments, the loaded config and the project root
   */
  test("runs the command with the config, the arguments and the root", async () => {
    writeFileSync(join(root, "craft.config.ts"), CONFIG);
    const result = await runProjectCommand("demo echo", ["books"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output ?? "")).toEqual({
      args: ["books"],
      marker: "from-config",
      rootIsCwd: true,
    });
  });

  /**
   * @case The three ways a command cannot run
   * @preconditions A command that throws; a config that registers nothing under the name; a directory with no config
   * @expectedResult Exit 1 each time: the thrown message, the import that provides MCP commands, and the missing config file named
   */
  test("reports a throw, an unregistered command and a missing config", async () => {
    writeFileSync(join(root, "craft.config.ts"), CONFIG);
    expect(await runProjectCommand("demo echo", ["throw"])).toEqual({
      code: 1,
      error: "the command failed",
    });

    const missing = await runProjectCommand("mcp nothing", []);
    expect(missing.code).toBe(1);
    expect(missing.error).toContain('import "@routecraft/ai";');

    rmSync(join(root, "craft.config.ts"));
    const none = await runProjectCommand("demo echo", []);
    expect(none.code).toBe(1);
    expect(none.error).toContain("No craft.config.ts found");
  });
});
