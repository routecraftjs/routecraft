/**
 * Recognising a promise by contract rather than by class.
 *
 * Standard Schema says `validate()` returns a result or a promise of one,
 * and JavaScript says "promise" is anything with a callable `then`, not
 * only an instance of `Promise`. The two diverge for a thenable a library
 * hand-rolls, and for a genuine native `Promise` built in another realm,
 * which fails `instanceof` in this one. Gating on the class misses both
 * (#545), so every site that has to decide "is this asynchronous" tests
 * for `then`.
 *
 * Core-internal on purpose: this is plumbing, and
 * `DEFINITION_OF_DONE.md` bars new `@internal` symbols from the public
 * entry point. `@routecraft/ai` cannot reach this module across the
 * package boundary and keeps its own copy at the AI SDK seam.
 */

/**
 * Whether a value is thenable, and so must be awaited or adapted before
 * its settled value can be read.
 *
 * A thenable is not necessarily a `Promise`, so it carries no `catch` or
 * `finally`. Normalise with `Promise.resolve(value)` before reaching for
 * either.
 *
 * @internal
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}
