import type { CallerRefusal } from "../../pipeline/caller-refusal.ts";
import type { OpsDispatchOutcome } from "../../plugins/ops/types.ts";

/**
 * What a runner hands the `argv()` source: the command line and where to
 * report the one outcome.
 *
 * Set by `craft run` (or any runner) in the context store under
 * `RUNNER_INVOCATION` before `context.start()`. A context without it, such
 * as one booted by `craft start`, has no command line to read, and `argv()`
 * stays inert there.
 */
export interface RunnerInvocation {
  /**
   * The route's input arguments after the file, with the runner's own flags
   * already taken out.
   */
  readonly argv: readonly string[];
  /** The runner was asked for the route's help instead of a run. */
  readonly help: boolean;
  /**
   * Flag names the runner reads itself after the file (`help` and `format`
   * for `craft run`). A route whose `.input()` body declares one is refused,
   * because that field could never reach it.
   */
  readonly reserved: readonly string[];
  /**
   * Read input piped on stdin, or `undefined` when none was piped.
   *
   * A function rather than a value so nothing reads stdin unless an `argv()`
   * source needs it: a stdio MCP route under the same runner owns stdin.
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
 * - `dropped`: a filter declined the exchange; there is no result.
 * - `help`: `--help` was asked for; nothing ran.
 * - `usage`: the command line itself was wrong; nothing ran.
 * - `refused`: the route's `.input()` or `.authorize()`, or a validate hook,
 *   refused what the caller sent or who the caller is.
 * - `failed`: the route ran and failed.
 */
export type RunnerOutcome =
  | OpsDispatchOutcome
  | { outcome: "help"; route: ArgvRouteHelp }
  | { outcome: "usage"; message: string }
  | { outcome: "refused"; refusal: CallerRefusal }
  | { outcome: "failed"; message: string };
