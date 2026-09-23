/**
 * The log settings, from flags and from env files, as a person running
 * `craft` sees them take effect.
 *
 * These run the CLI in a child process on purpose. A setting only fails when
 * something loads core before the command has put it in the environment, and
 * that ordering exists at process start, which an in-process call to a
 * command cannot reproduce. 0.7.0 shipped with both flags ignored, and with
 * every env file but Bun's own `.env` too late for the logger, because
 * nothing covered this path.
 *
 * `CRAFT_CLI_ENTRY` points the suite at another entry, which is how CI runs
 * the same cases against the built `dist/index.js`: the bundle can reorder
 * module loading without any change to the source.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How long a `craft` child may run before it counts as hung rather than slow. */
const CHILD_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 10_000;

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

/** A project whose settings define a `staging` profile that `--profile` selects. */
const PROFILED = join(DIR, "profiled");
/** A project whose settings file itself selects `staging`, whose env file names a log file. */
const SELECTED = join(DIR, "selected");
const SELECTED_LOG = join(DIR, "selected.log");
/** An env file for `--env`, carrying the log settings. */
const ENV_FILE = join(DIR, "logging.env");
const ENV_LOG = join(DIR, "env.log");

/** A route that leaves a file behind when it runs, so not running is observable. */
const MARKER_ROUTE = join(DIR, "marker.ts");
const MARKER = join(DIR, "marker-ran");
/**
 * Unwritable even for root: its parent is a regular file. The basename is
 * unique because core, left to itself, diverts the logs to a file of that
 * name in the temporary directory.
 */
const UNWRITABLE_LOG = join(ROUTE, `craft-unwritable-${process.pid}.log`);

const ROUTE_SOURCE = [
  'import { craft, log, simple } from "@routecraft/routecraft";',
  `export default craft().id("${ROUTE_ID}").from(simple("probe")).to(log());`,
  "",
].join("\n");

const MARKER_SOURCE = [
  'import { writeFileSync } from "node:fs";',
  'import { craft, simple } from "@routecraft/routecraft";',
  `export default craft().id("marker").from(simple("probe")).to(() => writeFileSync(${JSON.stringify(MARKER)}, "ran"));`,
  "",
].join("\n");

/** What a finished `craft` child left behind. */
interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `craft` from `cwd` with no logging configured anywhere but its
 * arguments and the project's own files, and report how it ended.
 */
async function invoke(cwd: string, args: string[]): Promise<Outcome> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    // JSON lines rather than the pretty transport, so output is countable.
    NODE_ENV: "production",
  };
  delete env["LOG_LEVEL"];
  delete env["CRAFT_LOG_LEVEL"];
  delete env["LOG_FILE"];
  delete env["CRAFT_LOG_FILE"];
  delete env["CRAFT_PROFILE"];
  delete env["CRAFT_CLI_ENTRY"];
  try {
    const { stdout, stderr } = await run("bun", [ENTRY, ...args], {
      env,
      cwd,
      timeout: CHILD_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as {
      killed?: boolean;
      code?: unknown;
      stdout?: string;
      stderr?: string;
    };
    if (failed.killed) {
      throw new Error(
        `craft ${args.join(" ")} did not exit within ${CHILD_TIMEOUT_MS}ms: something now holds the process open`,
      );
    }
    if (typeof failed.code !== "number") throw error;
    return {
      code: failed.code,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

/** Run `craft` from `cwd`, expecting success, and return its stdout. */
async function craftIn(cwd: string, ...args: string[]): Promise<string> {
  const outcome = await invoke(cwd, args);
  if (outcome.code !== 0) {
    throw new Error(
      `craft ${args.join(" ")} exited ${outcome.code}: ${outcome.stderr}`,
    );
  }
  return outcome.stdout;
}

/** Run `craft` from the fixture directory, expecting success. */
async function craft(...args: string[]): Promise<string> {
  return craftIn(DIR, ...args);
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
  await writeFile(MARKER_ROUTE, MARKER_SOURCE);

  await mkdir(join(PROFILED, ".routecraft"), { recursive: true });
  await writeFile(
    join(PROFILED, ".routecraft", "settings.yaml"),
    "profiles:\n  staging: {}\n",
  );
  await writeFile(join(PROFILED, ".env.staging"), "LOG_LEVEL=info\n");

  await mkdir(join(SELECTED, ".routecraft"), { recursive: true });
  await writeFile(
    join(SELECTED, ".routecraft", "settings.yaml"),
    "profile: staging\nprofiles:\n  staging: {}\n",
  );
  await writeFile(
    join(SELECTED, ".env.staging"),
    `LOG_LEVEL=info\nLOG_FILE=${SELECTED_LOG}\n`,
  );

  await writeFile(ENV_FILE, `LOG_LEVEL=info\nLOG_FILE=${ENV_LOG}\n`);
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
  await rm(join(tmpdir(), `craft-unwritable-${process.pid}.log`), {
    force: true,
  });
});

describe("craft logging flags", () => {
  /**
   * @case The global `--log-level` flag before the command
   * @preconditions No log level in the environment; `craft --log-level info run <route>`
   * @expectedResult The route's own info lines reach stdout
   */
  test(
    "--log-level before the command raises the level",
    async () => {
      const stdout = await craft("--log-level", "info", "run", ROUTE);
      expect(routeInfoLines(stdout).length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * @case The command's own `--log-level` flag
   * @preconditions No log level in the environment; `craft run --log-level info <route>`
   * @expectedResult The route's own info lines reach stdout, the same as the global form
   */
  test(
    "--log-level after the command raises the level",
    async () => {
      const stdout = await craft("run", "--log-level", "info", ROUTE);
      expect(routeInfoLines(stdout).length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * @case The global `--log-file` flag keeps stdout free of log lines
   * @preconditions No log destination in the environment; `craft --log-level info --log-file <file> run <route>`
   * @expectedResult Every log line lands in the file and none on stdout, which an MCP stdio transport depends on
   */
  test(
    "--log-file moves every log line off stdout",
    async () => {
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
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * @case `start` with its own flags, the way an MCP host launches a project
   * @preconditions No logging in the environment; a global `--log-level warn`, then `start <project> --once --log-level info --log-file <file>`
   * @expectedResult stdout carries no log line, and the file holds the route's info lines, so the command's own flags beat the global one
   */
  test(
    "start honours its own flags over the global ones",
    async () => {
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
    },
    TEST_TIMEOUT_MS,
  );
});

describe("craft log settings from env files", () => {
  /**
   * @case A profile's env file sets the log level
   * @preconditions No log level in the process; a project whose settings define `staging` and whose `.env.staging` says `LOG_LEVEL=info`; `craft run --profile staging <route>` from that project
   * @expectedResult The route's own info lines reach stdout, so the profile's environment was in place before core built the logger
   */
  test(
    "LOG_LEVEL in the selected profile's env file raises the level",
    async () => {
      const stdout = await craftIn(
        PROFILED,
        "run",
        "--profile",
        "staging",
        ROUTE,
      );
      expect(routeInfoLines(stdout).length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * @case `--env <file>` carries the log destination
   * @preconditions No log settings in the process; an env file with `LOG_LEVEL=info` and `LOG_FILE=<file>`; `craft run --env <env file> <route>`
   * @expectedResult stdout carries no log line and the named file holds the route's info lines
   */
  test(
    "LOG_FILE in an --env file moves log lines off stdout",
    async () => {
      await rm(ENV_LOG, { force: true });
      const stdout = await craft("run", "--env", ENV_FILE, ROUTE);
      expect(logLines(stdout)).toEqual([]);
      const written = await readFile(ENV_LOG, "utf8");
      expect(routeInfoLines(written).length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * @case A logging flag beats the same setting from an env file
   * @preconditions A project whose settings file selects `staging`, whose `.env.staging` sets `LOG_LEVEL=info` and `LOG_FILE=<file>` (a profile file overrides the process environment); `craft run --log-level warn <route>` from that project
   * @expectedResult The env file's log file is used, so it was applied, yet it holds no info line from the route, because the flag's level won; stdout carries no log line
   */
  test(
    "--log-level beats LOG_LEVEL from an env file",
    async () => {
      await rm(SELECTED_LOG, { force: true });
      const stdout = await craftIn(
        SELECTED,
        "run",
        "--log-level",
        "warn",
        ROUTE,
      );
      expect(logLines(stdout)).toEqual([]);
      const written = await readFile(SELECTED_LOG, "utf8");
      expect(routeInfoLines(written)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("craft with a log file it cannot write", () => {
  /**
   * @case `--log-file` names a file that cannot be created
   * @preconditions `craft run --log-file <path under a regular file> <route>`, where the route writes a marker file when it runs
   * @expectedResult A non-zero exit, a message on stderr naming the path and the flag, and no marker, so the route never ran with its logs diverted
   */
  test(
    "an unwritable --log-file refuses to start",
    async () => {
      await rm(MARKER, { force: true });
      const outcome = await invoke(DIR, [
        "run",
        "--log-file",
        UNWRITABLE_LOG,
        MARKER_ROUTE,
      ]);
      expect(outcome.code).not.toBe(0);
      expect(outcome.stderr).toMatch(/cannot write logs/i);
      expect(outcome.stderr).toContain(UNWRITABLE_LOG);
      expect(outcome.stderr).toContain("--log-file");
      expect(existsSync(MARKER)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
