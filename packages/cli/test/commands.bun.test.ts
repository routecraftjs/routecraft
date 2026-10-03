/**
 * What `craft` offers, as somebody typing `craft --help` sees it.
 *
 * The surface is the contract with every script anybody has written, so a
 * command arriving and a command leaving are both worth pinning. `craft
 * chat` left with no shim, no alias and no pointer: an editor speaking the
 * Agent Client Protocol is what replaced it, and a terminal chat client is
 * a product somebody else sells.
 */

import { describe, expect, test } from "bun:test";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

/** Run the CLI and return what it printed, whatever it exited with. */
async function help(...args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run("bun", [ENTRY, ...args], {
      env: { ...process.env, CRAFT_LOG_LEVEL: "silent" },
    });
    return `${stdout}${stderr}`;
  } catch (error: unknown) {
    // `--help` exits non-zero on some paths; what it printed is the point.
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
}

describe("the craft command surface", () => {
  /**
   * @case The editor bridge is registered and described
   * @preconditions `craft --help`
   * @expectedResult `acp` is listed, so an editor configured to run it finds it
   */
  test("acp is registered", async () => {
    expect(await help("--help")).toContain("acp");
  }, 30_000);

  /**
   * @case The bridge takes the flags a profile resolves
   * @preconditions `craft acp --help`
   * @expectedResult Every flag the resolution chain reads is offered, and no login flow is: a token in the profile is what authenticates
   */
  test("acp offers the profile flags and no login", async () => {
    const text = await help("acp", "--help");
    for (const flag of ["--profile", "--url", "--token", "--agent"]) {
      expect(text).toContain(flag);
    }
    expect(text).not.toContain("--login");
  }, 30_000);

  /**
   * @case craft chat is gone, with no shim and no pointer
   * @preconditions `craft --help`
   * @expectedResult Nothing names it. A deprecated command that still prints something is a command somebody's script still calls
   */
  test("chat is not registered", async () => {
    expect(await help("--help")).not.toContain("chat");
  }, 30_000);

  /**
   * @case The commands that reach an instance all take a profile
   * @preconditions `craft exec --help`, `craft ops routes --help` and `craft acp --help`
   * @expectedResult Each offers `--profile` and `--project`, so one selection, and the project it is read from, move every command in the family to another instance
   */
  test("the instance-facing commands take a profile", async () => {
    for (const command of [["exec"], ["ops", "routes"], ["acp"]]) {
      const text = await help(...command, "--help");
      expect(text).toContain("--profile");
      expect(text).toContain("--project");
    }
  }, 30_000);

  /**
   * @case The commands that boot a context take the logging flags directly
   * @preconditions `craft start --help` and `craft run --help`
   * @expectedResult Both offer `--log-level` and `--log-file`. They were
   *   global-only, which `enablePositionalOptions` confines to the space
   *   before the subcommand: `craft start --log-level info` died on "unknown
   *   option" and `craft run app.ts --log-level info` was swallowed by the
   *   pass-through and handed to the route
   */
  test("the commands that boot a context take the logging flags", async () => {
    const startHelp = await help("start", "--help");
    expect(startHelp).toContain("--log-level");
    expect(startHelp).toContain("--log-file");
    const runHelp = await help("run", "--help");
    expect(runHelp).toContain("--log-level");
    expect(runHelp).toContain("--log-file");
  }, 30_000);

  /**
   * @case An editor starts the bridge from a project other than the one holding the profile
   * @preconditions A profile defined only in one project's `.routecraft/settings.yaml`, an empty home, and `craft acp --project <that project> --profile editor` run from an unrelated working directory
   * @expectedResult The profile is resolved from the named project: the run fails on the profile's unreachable address, naming that file as the source, rather than reporting the profile as missing
   */
  test("acp reads the profile from the project it is given", async () => {
    const project = mkdtempSync(join(tmpdir(), "craft-acp-project-"));
    mkdirSync(join(project, ".routecraft"));
    writeFileSync(
      join(project, ".routecraft", "settings.yaml"),
      "profiles:\n  editor:\n    url: http://127.0.0.1:1\n",
    );
    const elsewhere = mkdtempSync(join(tmpdir(), "craft-acp-elsewhere-"));
    const home = mkdtempSync(join(tmpdir(), "craft-acp-home-"));
    // The bridge connects on the editor's first message, so send one.
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    try {
      const result = spawnSync(
        "bun",
        [ENTRY, "acp", "--project", project, "--profile", "editor"],
        {
          cwd: elsewhere,
          env: { ...process.env, HOME: home, CRAFT_LOG_LEVEL: "silent" },
          input: `${initialize}\n`,
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toContain('No profile "editor"');
      expect(output).toContain("http://127.0.0.1:1/acp");
      expect(output).toContain(project);
    } finally {
      for (const dir of [project, elsewhere, home]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  /**
   * @case A mistyped project path is refused rather than ignored
   * @preconditions `craft acp --project <a path that does not exist> --profile editor`
   * @expectedResult Exit 2 with the path named, not a fall-through to the global settings file that would send its token to whatever instance it names
   */
  test("acp refuses a project that is not a directory", () => {
    const missing = join(tmpdir(), "craft-acp-missing-project");
    const result = spawnSync(
      "bun",
      [ENTRY, "acp", "--project", missing, "--profile", "editor"],
      {
        env: { ...process.env, CRAFT_LOG_LEVEL: "silent" },
        input: "",
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain(missing);
  }, 30_000);
});
