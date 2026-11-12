import type { Source } from "../../operations/from";
import { ArgvSourceAdapter } from "./source";
import { tagAdapter, factoryArgs } from "../shared/factory-tag";

/**
 * Creates a source that turns the command line of `craft run <file>` into
 * one exchange.
 *
 * The arguments after the file become the body with the grammar
 * `craft exec` uses (`--field=value` or `--field value`, a bare flag is
 * `true`, a repeated flag an array, nothing coerced). With no arguments,
 * JSON piped on stdin becomes the body; with arguments, stdin is not read.
 * `.input()` applies as on every other door. The exchange carries no principal, because a command
 * line proves no identity: a route with `.authorize()` fails here unless a
 * plugin supplies a principal on the way in. After
 * the one exchange the source completes and the runner prints the result
 * and exits.
 *
 * Flags the runner reads itself after the file (`--help` and `--format` for
 * `craft run`) never reach the route, so `craft run` refuses a route whose
 * `.input()` body declares a field of that name, as far as the schema renders
 * as JSON Schema.
 *
 * Inert when no runner handed over a command line, as under `craft start`,
 * so a route can declare it beside `direct()` and `mcp()` without branching.
 * A file can hold several `argv()` routes: the runner names the one to run
 * (`craft run <file> <route>`) and the others stay inert.
 *
 * @returns A Source usable with `.from(argv())`
 *
 * @example
 * ```typescript
 * craft()
 *   .id("work-item")
 *   .input({ body: WorkItemQuery })
 *   .from(argv(), direct())
 *   .enrich(fetchWorkItem)
 * ```
 */
export function argv(): Source<unknown> {
  return tagAdapter(new ArgvSourceAdapter(), argv, factoryArgs());
}

export { argvRouteIds, describeArgvRoute } from "./source";
export type { ArgvRouteHelp, RunnerInvocation, RunnerOutcome } from "./types";
