import type { Enricher } from "@routecraft/routecraft";
import { ShellEnricherAdapter } from "./enricher.ts";
import type { ShellArgs, ShellOptions, ShellResult } from "./types.ts";

/**
 * Run a command, isolated by default, and produce its output.
 *
 * ## The security boundary
 *
 * `shell()` never invokes a shell. It spawns the named program directly
 * with an argument vector, so no `bash`, `zsh` or `sh -c` ever interprets
 * a command line and an argument can never become a command, however
 * hostile its content. An author who wants shell interpretation writes
 * `shell("bash", ["-c", script])` and owns that visibly.
 *
 * Two things layer on top of that boundary. Arguments carry
 * control-character hygiene, and values wrapped in `untrusted()` also get
 * flag-injection protection, which is what stops an exchange-supplied
 * `url` of `--upload-pack=...` being read by `git` as its own option. And
 * the command runs inside an isolation tier: `unshare` by default, which
 * denies network egress, hides host processes, and withholds the caller's
 * privileges.
 *
 * Read the chosen tier's own documentation for what it does and does not
 * contain. The `unshare` tier in particular does NOT stop the command
 * reading files the calling user can read, `~/.ssh` and `.env` included.
 *
 * A tier that cannot be established fails with `OS1001` naming the cause
 * and the ways out. It never silently downgrades to a weaker one.
 *
 * ## Position selects nothing else
 *
 * The adapter is fetch-shaped: `.to()` replaces the body with the result,
 * `.enrich()` merges it, `.tap()` discards it. Output is always captured.
 *
 * @param command - The program to run. A program name, not a command line.
 * @param args - Its arguments, fixed or derived from the exchange. Wrap
 *   anything originating outside the route's code in `untrusted()`.
 * @param options - Isolation, environment, timeout and output settings
 * @returns An Enricher producing `{ stdout, stderr, exitCode, signal?, truncated }`
 *
 * @example
 * ```typescript
 * .enrich(shell("git", (ex) => ["clone", untrusted(ex.body.url), "/work"], {
 *   network: true,
 *   timeout: 60_000,
 * }))
 * ```
 *
 * @example Reading an exit code rather than failing on it
 * ```typescript
 * .enrich(shell("grep", ["-q", "TODO", "src"], { failOnNonZero: false }))
 * ```
 */
export function shell<T = unknown>(
  command: string,
  args?: ShellArgs<T>,
  options?: ShellOptions<T>,
): Enricher<T, ShellResult> {
  return new ShellEnricherAdapter<T>(command, args, options ?? {});
}

export { untrusted, type ShellArg, type UntrustedArg } from "./untrusted.ts";
export { shellPlugin, type ShellPluginOptions } from "./plugin.ts";
export type {
  IsolationName,
  ShellArgs,
  ShellOptions,
  ShellResult,
} from "./types.ts";
