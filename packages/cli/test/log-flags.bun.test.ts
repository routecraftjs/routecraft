/**
 * The logging flags, as a person running `craft` sees them take effect.
 *
 * These run the CLI in a child process on purpose. The flags only fail when
 * something loads core before a command has applied them, and that ordering
 * exists at process start, which an in-process call to a command cannot
 * reproduce. 0.7.0 shipped with both flags ignored because nothing covered
 * this path.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

// Inside the package so the fixture's import of core resolves through the
// workspace, the same way `run.bun.test.ts` places its temporary files.
const DIR = join(import.meta.dir, `tmp-log-flags-${process.pid}`);
const ROUTE = join(DIR, "route.ts");
const LOG_FILE = join(DIR, "craft.log");

/** Run `craft` with no logging configured anywhere but its arguments. */
async function craft(...args: string[]): Promise<string> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    // JSON lines rather than the pretty transport, so output is countable.
    NODE_ENV: "production",
  };
  delete env["LOG_LEVEL"];
  delete env["CRAFT_LOG_LEVEL"];
  delete env["LOG_FILE"];
  delete env["CRAFT_LOG_FILE"];
  const { stdout } = await run("bun", [ENTRY, ...args], { env, cwd: DIR });
  return stdout;
}

/** The info-level log lines in a chunk of pino JSON output. */
function infoLines(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("{") && line.includes('"level":"info"'));
}

beforeAll(async () => {
  await mkdir(DIR, { recursive: true });
  await writeFile(
    ROUTE,
    [
      'import { craft, log, simple } from "@routecraft/routecraft";',
      'export default craft().id("log-flags").from(simple("probe")).to(log());',
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

describe("craft logging flags", () => {
  /**
   * @case The global `--log-level` flag before the command
   * @preconditions No log level in the environment; `craft --log-level info run <route>`
   * @expectedResult Info lines reach stdout, including the route's own log adapter output
   */
  test("--log-level before the command raises the level", async () => {
    const stdout = await craft("--log-level", "info", "run", ROUTE);
    expect(infoLines(stdout).some((l) => l.includes("LogAdapter output"))).toBe(
      true,
    );
  });

  /**
   * @case The command's own `--log-level` flag
   * @preconditions No log level in the environment; `craft run --log-level info <route>`
   * @expectedResult Info lines reach stdout, the same as the global form
   */
  test("--log-level after the command raises the level", async () => {
    const stdout = await craft("run", "--log-level", "info", ROUTE);
    expect(infoLines(stdout).some((l) => l.includes("LogAdapter output"))).toBe(
      true,
    );
  });

  /**
   * @case `--log-file` keeps stdout free of log lines
   * @preconditions No log destination in the environment; `craft --log-level info --log-file <file> run <route>`
   * @expectedResult Every log line lands in the file and none on stdout, which an MCP stdio transport depends on
   */
  test("--log-file moves every log line off stdout", async () => {
    await rm(LOG_FILE, { force: true });
    const stdout = await craft(
      "--log-level",
      "info",
      "--log-file",
      LOG_FILE,
      "run",
      ROUTE,
    );
    expect(infoLines(stdout)).toEqual([]);
    const written = await readFile(LOG_FILE, "utf8");
    expect(
      infoLines(written).some((l) => l.includes("LogAdapter output")),
    ).toBe(true);
  });
});
