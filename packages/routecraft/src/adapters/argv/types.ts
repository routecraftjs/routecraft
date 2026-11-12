import type { CallerRefusal } from "../../pipeline/caller-refusal.ts";
import type { Deferred } from "../../kernel/continuation/deferred.ts";

/**
 * What a runner hands the `argv()` source: which route runs, the command
 * line and where to report the one outcome.
 *
 * Set by `craft run` (or any runner) in the context store under
 * `RUNNER_INVOCATION` before `context.start()`. A context without it, such
 * as one booted by `craft start`, has no command line to read, and `argv()`
 * stays inert there.
 */
export interface RunnerInvocation {
  /**
   * The route this invocation runs. An `argv()` source on any other route
   * stays inert, so a file can hold several and the runner picks one. An id
   * no `argv()` route carries leaves every source inert and `settle` is
   * never called, so pick it from `argvRouteIds(context)`.
   */
  readonly routeId: string;
  /**
   * The route's input arguments after the file, with the runner's own flags
   * (such as `--help` and `--format` for `craft run`) already taken out.
   */
  readonly argv: readonly string[];
  /**
   * Read input piped on stdin, or `undefined` when none was piped.
   *
   * A function rather than a value so stdin is read only when the source got
   * no arguments, the same rule `craft exec` follows. A pipe that never
   * closes therefore waits, as it does for `craft exec`.
   */
  readStdin(): Promise<string | undefined>;
  /** Report the invocation's outcome. Called once. */
  settle(outcome: RunnerOutcome): void;
}

/** What `--help` describes: the route and the input its `.input()` accepts. */
export interface ArgvRouteHelp {
  id: string;
  title?: string;
  description?: string;
  /** The `.input()` body schema rendered as JSON Schema, when it renders. */
  input?: unknown;
}

/**
 * How one command-line invocation ended, for the runner to render and turn
 * into an exit code.
 *
 * - `completed`: the route produced `body`.
 * - `deferred`: the route parked the exchange; `deferral` is the
 *   acknowledgement a caller resumes it with.
 * - `dropped`: the route dropped the exchange; there is no result.
 * - `usage`: the command line itself was wrong; nothing ran.
 * - `refused`: the route's `.input()`, a validate hook, or its `.validate()`
 *   step refused what the caller sent or who the caller is. The door admits
 *   no principal, so an `.authorize()` refusal is `failed`, even of a
 *   plugin-supplied one.
 * - `failed`: the route ran and failed.
 *
 * The first three arms match the ops dispatch outcome, spelled out because
 * a core type may not import from a plugin.
 */
export type RunnerOutcome =
  | { outcome: "completed"; body: unknown }
  | { outcome: "deferred"; deferral: Deferred }
  | { outcome: "dropped"; message: string }
  | { outcome: "usage"; message: string }
  | { outcome: "refused"; refusal: CallerRefusal }
  | { outcome: "failed"; message: string };
