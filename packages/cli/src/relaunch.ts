/**
 * Keeps `craft` on its own install when it runs outside a project.
 *
 * With no `node_modules` in the working directory or above it, Bun switches
 * the whole process to auto-install: every bare import, the CLI's own
 * included, resolves into Bun's download cache instead of the CLI's install.
 * A lone file given to `craft run` then loads a second, cached copy of core
 * that can find neither its optional peers nor pino's worker dependencies.
 *
 * So outside a project, meaning anywhere core is not installed, the CLI
 * starts itself again with `--no-install` and a `NODE_PATH` of the working
 * directory's `node_modules` first and the CLI's own after them. `NODE_PATH`
 * is consulted only after ordinary resolution fails, so a lone file gets the
 * CLI's core, and a peer that core asks for is found beside the file when
 * someone followed RC5017's `bun add` there, or beside the CLI otherwise.
 *
 * Nothing here may load `@routecraft/routecraft`: see the entry point.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

/** Set on the relaunched process so it never relaunches again. */
export const RELAUNCHED_ENV = "CRAFT_CLI_RELAUNCHED";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

/**
 * Whether `dir` is outside any project: no `node_modules` above it carries
 * core. That covers Bun's auto-install case, where there is no
 * `node_modules` at all, and a lone file whose folder holds only the peers
 * someone installed beside it.
 *
 * @internal
 */
export function isOutsideProject(dir: string): boolean {
  return !nodeModulesAbove(dir).some((modules) =>
    existsSync(join(modules, "@routecraft", "routecraft", "package.json")),
  );
}

/**
 * The `NODE_PATH` a relaunched CLI runs with: the working directory's
 * `node_modules` first, then the CLI's own, then whatever was already set.
 *
 * @internal
 */
export function relaunchNodePath(
  cwd: string,
  packageRoot: string,
  existing: string | undefined,
): string {
  const entries = [
    ...nodeModulesAbove(cwd),
    ...nodeModulesAbove(packageRoot),
    ...(existing?.split(delimiter) ?? []),
  ].filter(Boolean);
  return [...new Set(entries)].join(delimiter);
}

/**
 * Every `node_modules` directory Node-style resolution would search from
 * `dir`, nearest first.
 *
 * @internal
 */
export function nodeModulesAbove(dir: string): string[] {
  const found: string[] = [];
  const { root } = parse(dir);
  for (let current = dir; ; current = dirname(current)) {
    if (basename(current) !== "node_modules") {
      const candidate = join(current, "node_modules");
      if (existsSync(candidate)) found.push(candidate);
    }
    if (current === root) return found;
  }
}

/**
 * Start this CLI again as a child with auto-install off and its own
 * dependencies on `NODE_PATH`, when it was launched outside a project.
 * Resolves to the child's exit code, or to `undefined` when no relaunch is
 * needed and the caller should carry on in this process.
 *
 * @param entry - URL of the CLI entry module, for the child to run.
 */
export function relaunchOutsideProject(
  entry: string,
): Promise<number> | undefined {
  if (process.env[RELAUNCHED_ENV] === "1") return undefined;
  if (!isOutsideProject(process.cwd())) return undefined;

  const entryPath = fileURLToPath(entry);
  const packageRoot = dirname(dirname(entryPath));

  const child = spawn(
    process.execPath,
    ["--no-install", entryPath, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        [RELAUNCHED_ENV]: "1",
        NODE_PATH: relaunchNodePath(
          process.cwd(),
          packageRoot,
          process.env["NODE_PATH"],
        ),
      },
    },
  );

  // A terminal Ctrl-C reaches both processes; the child ignores a repeated
  // signal during shutdown, so forwarding every one is safe.
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => child.kill(signal));
  }

  return new Promise((resolveExit) => {
    child.on("exit", (code, signal) => {
      resolveExit(code ?? (signal ? 128 + signalNumber(signal) : 1));
    });
    child.on("error", () => resolveExit(1));
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return numbers[signal] ?? 1;
}
