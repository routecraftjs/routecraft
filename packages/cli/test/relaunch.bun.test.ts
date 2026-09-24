/**
 * `craft` outside a project: a lone file given to `craft run` runs on the
 * CLI's own install rather than on whatever Bun's auto-install fetches.
 *
 * The end-to-end case runs the CLI in a child process from a directory with
 * no `node_modules` above it, because Bun decides auto-install once, at
 * process start, from the working directory. `CRAFT_CLI_ENTRY` points it at
 * the built bundle the same way `log-flags.bun.test.ts` does.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
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
  test("treats a directory with no node_modules above it as outside a project", async () => {
    if (!isOutsideProject(tmpdir())) return;
    expect(isOutsideProject(lone)).toBe(true);
  });

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
  test("a node_modules without core is still outside a project", async () => {
    const dir = join(lone, "with-peer");
    await mkdir(join(dir, "node_modules", "some-peer"), { recursive: true });
    if (!isOutsideProject(tmpdir())) return;
    expect(isOutsideProject(dir)).toBe(true);
  });

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
  test("runs on the CLI's own core", async () => {
    if (!isOutsideProject(tmpdir())) return;
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
    const env: Record<string, string | undefined> = {
      ...process.env,
      NODE_ENV: "production",
    };
    delete env["CRAFT_CLI_ENTRY"];
    delete env["CRAFT_CLI_RELAUNCHED"];
    delete env["NODE_PATH"];

    await run("bun", [ENTRY, "run", "route.ts"], {
      cwd: lone,
      env,
      timeout: 20_000,
    });

    const resolved = await readFile(marker, "utf-8");
    expect(resolved).toContain(REPO_ROOT);
    expect(resolved).not.toContain(join(".bun", "install", "cache"));
  }, 30_000);
});
