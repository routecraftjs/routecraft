/**
 * `craft` outside a project: a lone file given to `craft run` runs on the
 * CLI's own install rather than on whatever Bun's auto-install fetches.
 *
 * The end-to-end cases run the CLI in a child process from a directory with
 * no `node_modules` above it, because Bun decides auto-install once, at
 * process start, from the working directory. A file there reaches core
 * through the package's entry, which is `dist/`: inside the repository the
 * root tsconfig maps `@routecraft/*` to source, but a lone file has no
 * tsconfig. So these cases need a built core and skip without one; the
 * `scaffolder-smoke` job runs them against the bundle that ships, with
 * `CRAFT_CLI_ENTRY` pointing at it the same way `log-flags.bun.test.ts` does.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  RELAUNCHED_ENV,
  isOutsideProject,
  nodeModulesAbove,
  relaunchNodePath,
} from "../src/relaunch.ts";

const run = promisify(execFile);

const ENTRY = resolve(
  process.env["CRAFT_CLI_ENTRY"] ??
    join(import.meta.dir, "..", "src", "index.ts"),
);
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** A temporary directory with a node_modules above it cannot host these cases. */
const TMP_OUTSIDE = isOutsideProject(tmpdir());

/** A lone file resolves core through its package entry, which only a build provides. */
const CORE_BUILT = existsSync(
  join(REPO_ROOT, "packages", "routecraft", "dist", "index.js"),
);
const LONE_FILE_CASES = TMP_OUTSIDE && CORE_BUILT;

/** The environment a person's shell would give `craft`, with no relaunch state. */
function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "production",
  };
  delete env["CRAFT_CLI_ENTRY"];
  delete env[RELAUNCHED_ENV];
  delete env["NODE_PATH"];
  return env;
}

/**
 * Start `craft run` on a lone file whose timer route writes the process id
 * to `marker` on every tick, and resolve once it has ticked.
 */
async function startLongRunning(
  name: string,
): Promise<{ parent: ChildProcess; childPid: number }> {
  const marker = join(lone, `${name}.pid`);
  await writeFile(
    join(lone, `${name}.ts`),
    [
      'import { writeFileSync } from "node:fs";',
      'import { craft, timer } from "@routecraft/routecraft";',
      `export default craft().id("${name}").from(timer({ interval: 100 })).to(() => writeFileSync(${JSON.stringify(marker)}, String(process.pid)));`,
      "",
    ].join("\n"),
  );
  const parent = spawn("bun", [ENTRY, "run", `${name}.ts`], {
    cwd: lone,
    env: cleanEnv(),
    stdio: "ignore",
  });
  const deadline = Date.now() + 15_000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error(`${name} never ticked`);
    await sleep(50);
  }
  return { parent, childPid: Number(await readFile(marker, "utf-8")) };
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((done) => child.once("exit", (code) => done(code)));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let lone: string;

beforeAll(async () => {
  lone = await mkdtemp(join(tmpdir(), "craft-lone-"));
});

afterAll(async () => {
  await rm(lone, { recursive: true, force: true });
});

describe("project detection", () => {
  /**
   * @case A directory inside this repository
   * @preconditions The repository root has a node_modules directory
   * @expectedResult It counts as inside a project, and the root node_modules is among the directories found
   */
  test("finds the node_modules a directory resolves from", () => {
    expect(isOutsideProject(import.meta.dir)).toBe(false);
    expect(nodeModulesAbove(import.meta.dir)).toContain(
      join(REPO_ROOT, "node_modules"),
    );
  });

  /**
   * @case A fresh directory under the system temporary directory
   * @preconditions No node_modules exists there or above it
   * @expectedResult It counts as outside a project, which is when Bun would auto-install
   */
  test.skipIf(!TMP_OUTSIDE)(
    "treats a directory with no node_modules above it as outside a project",
    () => {
      expect(isOutsideProject(lone)).toBe(true);
    },
  );

  /**
   * @case A node_modules directory in the path itself
   * @preconditions A directory named node_modules with a package folder inside it
   * @expectedResult The node_modules directory is reported once, not a nested node_modules/node_modules
   */
  test("does not look for node_modules inside node_modules", async () => {
    const pkg = join(lone, "tree", "node_modules", "@scope", "pkg");
    await mkdir(pkg, { recursive: true });
    expect(nodeModulesAbove(pkg)).toEqual([join(lone, "tree", "node_modules")]);
  });

  /**
   * @case A folder whose node_modules holds a peer but not core
   * @preconditions Someone ran RC5017's `bun add` beside a lone file, which created node_modules without core
   * @expectedResult It still counts as outside a project, so the file keeps running on the CLI's core
   */
  test.skipIf(!TMP_OUTSIDE)(
    "a node_modules without core is still outside a project",
    async () => {
      const dir = join(lone, "with-peer");
      await mkdir(join(dir, "node_modules", "some-peer"), { recursive: true });
      expect(isOutsideProject(dir)).toBe(true);
    },
  );

  /**
   * @case The lookup path a relaunched CLI runs with
   * @preconditions A working directory with its own node_modules, a CLI root with its own, and an inherited NODE_PATH
   * @expectedResult The working directory's node_modules comes first, the CLI's next, the inherited entries last, with no duplicates
   */
  test("puts the working directory's packages before the CLI's", async () => {
    const cwd = join(lone, "path-order");
    const cli = join(lone, "cli-root");
    await mkdir(join(cwd, "node_modules"), { recursive: true });
    await mkdir(join(cli, "node_modules"), { recursive: true });
    const inherited = ["/elsewhere", join(cli, "node_modules")].join(delimiter);

    const entries = relaunchNodePath(cwd, cli, inherited).split(delimiter);

    expect(entries.slice(0, 2)).toEqual([
      join(cwd, "node_modules"),
      join(cli, "node_modules"),
    ]);
    expect(entries.at(-1)).toBe("/elsewhere");
    expect(new Set(entries).size).toBe(entries.length);
  });
});

describe("craft run on a lone file", () => {
  /**
   * @case A route file in a directory with no package.json and no node_modules
   * @preconditions The CLI runs from that directory, so Bun would switch the process to auto-install
   * @expectedResult The route runs, and its import of core resolves inside the CLI's own install rather than Bun's download cache
   */
  test.skipIf(!LONE_FILE_CASES)(
    "runs on the CLI's own core",
    async () => {
      const marker = join(lone, "resolved-core");
      await writeFile(
        join(lone, "route.ts"),
        [
          'import { writeFileSync } from "node:fs";',
          'import { craft, simple } from "@routecraft/routecraft";',
          `export default craft().id("lone").from(simple("probe")).to(() => writeFileSync(${JSON.stringify(marker)}, import.meta.resolve("@routecraft/routecraft")));`,
          "",
        ].join("\n"),
      );
      await run("bun", [ENTRY, "run", "route.ts"], {
        cwd: lone,
        env: cleanEnv(),
        timeout: 20_000,
      });

      const resolved = await readFile(marker, "utf-8");
      expect(resolved).toContain(REPO_ROOT);
      expect(resolved).not.toContain(join(".bun", "install", "cache"));
    },
    30_000,
  );

  /**
   * @case A supervisor sends SIGTERM to the process it started, which is the relaunching parent
   * @preconditions A lone file with a timer route runs outside a project, so the route runs in a relaunched child
   * @expectedResult The parent forwards the signal, the child drains gracefully, and the caller sees exit 0
   */
  test.skipIf(!LONE_FILE_CASES || process.platform === "win32")(
    "a SIGTERM to the parent shuts the child down gracefully",
    async () => {
      const { parent } = await startLongRunning("graceful");
      const exited = exitOf(parent);

      parent.kill("SIGTERM");

      expect(await exited).toBe(0);
    },
    30_000,
  );

  /**
   * @case The relaunched child dies of a signal the parent never sent
   * @preconditions A lone file runs in a relaunched child; the child is sent SIGABRT directly, as a native crash would
   * @expectedResult The caller sees 128 + SIGABRT (134), not a code that names another signal
   */
  test.skipIf(!LONE_FILE_CASES || process.platform === "win32")(
    "reports the child's own signal in the exit code",
    async () => {
      const { parent, childPid } = await startLongRunning("aborted");
      const exited = exitOf(parent);

      process.kill(childPid, "SIGABRT");

      expect(await exited).toBe(134);
    },
    30_000,
  );

  /**
   * @case The relaunching parent is killed with SIGKILL, so it cannot forward anything
   * @preconditions A lone file with a timer route runs in a relaunched child
   * @expectedResult The child notices its parent is gone and stops on its own, rather than running on as an orphan
   */
  test.skipIf(!LONE_FILE_CASES || process.platform === "win32")(
    "the child stops when the parent is killed outright",
    async () => {
      const { parent, childPid } = await startLongRunning("orphaned");

      parent.kill("SIGKILL");

      const deadline = Date.now() + 10_000;
      while (isAlive(childPid) && Date.now() < deadline) await sleep(100);
      expect(isAlive(childPid)).toBe(false);
    },
    30_000,
  );
});
