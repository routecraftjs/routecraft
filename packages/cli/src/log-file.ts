import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { messageOf } from "./util.js";

/**
 * Where the logger will write, and who asked for it.
 *
 * Mirrors how core picks its destination: `LOG_FILE` before
 * `CRAFT_LOG_FILE`, and an empty value means standard output.
 */
export function logFileTarget(
  env: NodeJS.ProcessEnv = process.env,
): { path: string; source: string } | undefined {
  const source = env["LOG_FILE"] !== undefined ? "LOG_FILE" : "CRAFT_LOG_FILE";
  const path = env[source];
  return path ? { path, source } : undefined;
}

/**
 * Open the log file the way core's destination will, and say why it cannot
 * be opened.
 *
 * Core never fails over a log file it cannot open: it falls back to a file
 * of the same name in the temporary directory, then to standard error, and
 * the command runs on with its logs somewhere nobody looks. That fallback
 * suits an embedding application, which cannot be stopped by its logger;
 * the CLI owns the flag, so it refuses instead, before core is loaded.
 *
 * Creates missing parent directories and the file itself, exactly as core
 * does, so this refuses only what core would have diverted.
 *
 * @param path The log file, relative to `cwd` unless absolute
 * @param cwd Directory a relative path resolves against
 * @returns Why the file cannot be opened for appending, or undefined when it can
 */
export function logFileProblem(
  path: string,
  cwd: string = process.cwd(),
): string | undefined {
  const resolved = isAbsolute(path) ? path : resolve(cwd, path);
  const directory = dirname(resolved);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error: unknown) {
    return `cannot create its directory ${directory} (${messageOf(error)})`;
  }
  try {
    closeSync(openSync(resolved, "a"));
  } catch (error: unknown) {
    return `cannot open ${resolved} for appending (${messageOf(error)})`;
  }
  return undefined;
}
