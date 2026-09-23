/**
 * The logging flags, as a person running `craft` sees them take effect.
 *
 * These run the CLI in a child process on purpose. The flags only fail when
 * something loads core before a command has applied them, and that ordering
 * exists at process start, which an in-process call to a command cannot
 * reproduce. 0.7.0 shipped with both flags ignored because nothing covered
 * this path.
 *
 * `CRAFT_CLI_ENTRY` points the suite at another entry, which is how CI runs
 * the same cases against the built `dist/index.js`: the bundle can reorder
 * module loading without any change to the source.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const ENTRY = resolve(
  process.env["CRAFT_CLI_ENTRY"] ??
    join(import.meta.dir, "..", "src", "index.ts"),
);

// Inside the package so the fixture's import of core resolves through the
// workspace, the same way `run.bun.test.ts` places its temporary files.
const DIR = join(import.meta.dir, `tmp-log-flags-${process.pid}`);
const ROUTE_ID = "log-flags";
const ROUTE = join(DIR, "route.ts");
const PROJECT = join(DIR, "project");
const LOG_FILE = join(DIR, "craft.log");

const ROUTE_SOURCE = [
  'import { craft, log, simple } from "@routecraft/routecraft";',
  `export default craft().id("${ROUTE_ID}").from(simple("probe")).to(log());`,
  "",
].join("\n");

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
  delete env["CRAFT_CLI_ENTRY"];
  const { stdout } = await run("bun", [ENTRY, ...args], { env, cwd: DIR });
  return stdout;
}

/** Info-level log lines the probe route itself produced. */
function routeInfoLines(output: string): string[] {
  return output
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("{") &&
        line.includes('"level":"info"') &&
        line.includes(`"route":"${ROUTE_ID}"`),
    );
}

/** Every pino JSON line in a chunk of output. */
function logLines(output: string): string[] {
  return output.split("\n").filter((line) => line.startsWith('{"level"'));
}

beforeAll(async () => {
  await mkdir(join(PROJECT, "capabilities"), { recursive: true });
  await writeFile(ROUTE, ROUTE_SOURCE);
  await writeFile(
    join(PROJECT, "craft.config.ts"),
    "export const craftConfig = {};\n",
  );
  await writeFile(join(PROJECT, "capabilities", "probe.ts"), ROUTE_SOURCE);
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

describe("craft logging flags", () => {
  /**
   * @case The global `--log-level` flag before the command
   * @preconditions No log level in the environment; `craft --log-level info run <route>`
   * @expectedResult The route's own info lines reach stdout
   */
  test("--log-level before the command raises the level", async () => {
    const stdout = await craft("--log-level", "info", "run", ROUTE);
    expect(routeInfoLines(stdout).length).toBeGreaterThan(0);
  });

  /**
   * @case The command's own `--log-level` flag
   * @preconditions No log level in the environment; `craft run --log-level info <route>`
   * @expectedResult The route's own info lines reach stdout, the same as the global form
   */
  test("--log-level after the command raises the level", async () => {
    const stdout = await craft("run", "--log-level", "info", ROUTE);
    expect(routeInfoLines(stdout).length).toBeGreaterThan(0);
  });

  /**
   * @case The global `--log-file` flag keeps stdout free of log lines
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
    expect(logLines(stdout)).toEqual([]);
    const written = await readFile(LOG_FILE, "utf8");
    expect(routeInfoLines(written).length).toBeGreaterThan(0);
  });

  /**
   * @case `start` with its own flags, the way an MCP host launches a project
   * @preconditions No logging in the environment; a global `--log-level warn`, then `start <project> --once --log-level info --log-file <file>`
   * @expectedResult stdout carries no log line, and the file holds the route's info lines, so the command's own flags beat the global one
   */
  test("start honours its own flags over the global ones", async () => {
    await rm(LOG_FILE, { force: true });
    const stdout = await craft(
      "--log-level",
      "warn",
      "start",
      PROJECT,
      "--once",
      "--timeout",
      "10s",
      "--log-level",
      "info",
      "--log-file",
      LOG_FILE,
    );
    expect(logLines(stdout)).toEqual([]);
    const written = await readFile(LOG_FILE, "utf8");
    expect(routeInfoLines(written).length).toBeGreaterThan(0);
  });
});
