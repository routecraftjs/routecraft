/**
 * Whether a value is a thenable.
 *
 * Any thenable counts as async, not only a `Promise`: a hand-rolled one and a
 * native promise from another realm both fail an `instanceof` check, which is
 * why the repository's lint rule rejects that spelling outright.
 *
 * Core holds the same predicate in `shared/thenable.ts`, which is `@internal`
 * and so deliberately absent from `@routecraft/routecraft`'s entry point
 * (`DEFINITION_OF_DONE.md`: no new `@internal` symbols there). This package
 * cannot reach across that boundary, so it keeps ONE copy, here, rather than
 * the export being widened for a two-line predicate or the predicate being
 * respelled per file.
 *
 * @internal
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}
