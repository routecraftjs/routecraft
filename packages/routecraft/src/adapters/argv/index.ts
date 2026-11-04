import type { Source } from "../../operations/from";
import { ArgvSourceAdapter } from "./source";
import { tagAdapter, factoryArgs } from "../shared/factory-tag";

/**
 * Creates a source that turns the command line of `craft run <file>` into
 * one exchange.
 *
 * The arguments after the file become the body with the grammar
 * `craft exec` uses (`--field=value` or `--field value`, a bare flag is
 * `true`, a repeated flag an array, nothing coerced), or JSON piped on stdin
 * becomes the body; both at once is a usage error. The exchange carries the
 * local operator's principal with the scopes the operator configured, so
 * `.input()` and `.authorize()` apply as they do on every other door. After
 * the one exchange the source completes and the runner prints the result
 * and exits.
 *
 * Flags the runner reads itself after the file (`--help` and `--format` for
 * `craft run`) never reach the route, so a route declaring an input field of
 * that name is refused.
 *
 * Inert when no runner handed over a command line, as under `craft start`,
 * so a route can declare it beside `direct()` and `mcp()` without branching.
 *
 * @returns A Source usable with `.from(argv())`
 *
 * @example
 * ```typescript
 * craft()
 *   .id("work-item")
 *   .input({ body: WorkItemQuery })
 *   .authorize({ scopes: ["boards:read"] })
 *   .from(argv(), direct())
 *   .enrich(fetchWorkItem)
 * ```
 */
export function argv(): Source<unknown> {
  return tagAdapter(new ArgvSourceAdapter(), argv, factoryArgs());
}

export { argvRouteIds } from "./source";
export type { ArgvRouteHelp, RunnerInvocation, RunnerOutcome } from "./types";
