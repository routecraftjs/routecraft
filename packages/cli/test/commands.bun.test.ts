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
import { execFile } from "node:child_process";
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
   * @preconditions `craft exec --help` and `craft ops routes --help`
   * @expectedResult Both offer `--profile`, so one selection moves every command in the family to another instance
   */
  test("the instance-facing commands take a profile", async () => {
    expect(await help("exec", "--help")).toContain("--profile");
    expect(await help("ops", "routes", "--help")).toContain("--profile");
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
});
