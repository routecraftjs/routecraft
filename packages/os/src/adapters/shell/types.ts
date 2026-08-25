import type { Exchange } from "@routecraft/routecraft";
import type { Resolvable } from "../../shared/resolvable.ts";
import type { ShellArg } from "./untrusted.ts";

/**
 * Isolation mechanisms `shell()` can run a command under. Each tier is
 * named for the mechanism that provides it, so the name is the promise:
 * `unshare` means Linux kernel namespaces and nothing more, and a reader
 * who knows what `unshare` does already knows what the tier does.
 *
 * `docker` (#647) and `seatbelt` (#646) join this union when they ship.
 */
export type IsolationName = "none" | "unshare";

/** Arguments for a command: a fixed list, or derived from the exchange. */
export type ShellArgs<T> =
  readonly ShellArg[] | ((exchange: Exchange<T>) => readonly ShellArg[]);

/**
 * Options shared by every `shell()` call. Per-call values here beat the
 * `ROUTECRAFT_SHELL_ISOLATION` operator override, which beats
 * `shellPlugin()` context defaults: an operator can harden a loosely
 * configured deployment without being able to quietly weaken what a route
 * explicitly demanded. Isolation is the only option an operator can
 * override from the environment.
 */
export interface ShellOptions<T = unknown> {
  /**
   * Isolation tier. Defaults to `unshare`, which is Linux-only: on a host
   * that cannot provide the requested tier the call fails with `OS1001`
   * rather than running with less isolation than it claims. Write
   * `isolation: "none"` to run without isolation deliberately.
   */
  isolation?: IsolationName;
  /**
   * Allow network egress. Denied by default: the route grants what the
   * command may reach, the same way it grants environment variables.
   * Ignored by the `none` tier, which promises nothing and blocks nothing.
   */
  network?: boolean;
  /**
   * Map the caller to root inside the isolation tier's user namespace
   * instead of to itself. Off by default: a process that believes it is
   * root will chown and chmod things it should not, and workloads that
   * genuinely need root inside are the minority.
   */
  mapRootUser?: boolean;
  /** Working directory for the command. Defaults to the host process's. */
  cwd?: Resolvable<T, string>;
  /**
   * Environment variables granted to the command, by value. These are
   * added to the documented baseline (`PATH`, `HOME`, `LANG`, `TZ`) and
   * override it where the names collide.
   */
  env?: Record<string, string>;
  /**
   * Parent-process environment variables to forward by name. Nothing is
   * forwarded by default, so no credential-bearing variable reaches a
   * command that did not ask for it. A named variable that is unset in the
   * parent is simply absent; it is not an error.
   */
  passEnv?: readonly string[];
  /** Milliseconds before the command (and anything it spawned) is killed. */
  timeout?: number;
  /**
   * Throw `OS1002` when the command exits non-zero. On by default, because
   * a route whose `git push` failed should not continue as though it had.
   * Set false for commands whose exit code is data rather than failure
   * (`grep` with no match, `diff` with differences) and read `exitCode`
   * off the result instead.
   */
  failOnNonZero?: boolean;
  /**
   * Cap on captured output, per stream, in bytes. Defaults to 8 MiB.
   * Overflow keeps the head and the tail with a marker between them and
   * sets `truncated`, rather than failing: on a long build log the tail is
   * usually the part that explains the failure.
   */
  maxOutputBytes?: number;
}

/** What a command produced. */
export interface ShellResult {
  /** Captured standard output, capped per `maxOutputBytes`. */
  stdout: string;
  /** Captured standard error, capped per `maxOutputBytes`. */
  stderr: string;
  /** Exit status. `0` on success. */
  exitCode: number;
  /** Signal that killed the command, when one did. */
  signal?: string;
  /** True when either stream hit `maxOutputBytes` and was capped. */
  truncated: boolean;
}
