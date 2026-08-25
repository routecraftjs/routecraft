/**
 * Brand for a command argument the route author declares came from outside
 * the code: an exchange body, a header, an agent's tool call.
 *
 * @internal
 */
const UNTRUSTED_BRAND = Symbol.for("routecraft.os.shell.untrusted");

/** An argument value marked as coming from outside the route's code. */
export interface UntrustedArg {
  readonly [UNTRUSTED_BRAND]: true;
  readonly value: string;
}

/** A single `shell()` argument: a literal, or a marked untrusted value. */
export type ShellArg = string | UntrustedArg;

/**
 * Mark a command argument as coming from outside the route's own code, so
 * flag-injection protection applies to it.
 *
 * The security boundary of `shell()` is that it spawns the process directly
 * and never through a shell, so a value can never become a command however
 * hostile it is. What direct spawning does NOT stop is an argument that the
 * invoked program reads as one of its own options: a `url` of
 * `--upload-pack=...` handed to `git clone` is still just an argument, and
 * `git` still honours it. Marking the value is what turns flag protection on
 * for it.
 *
 * Protection is per value rather than blanket because it works by refusing
 * leading dashes, which would equally destroy the author's own flags: an
 * argv sanitised wholesale turns `--oneline` into `oneline`. Marking keeps
 * the guard on the values that need it and keeps the trust boundary visible
 * at the call site.
 *
 * @param value - The untrusted value, stringified if it is not already text
 *
 * @example
 * ```typescript
 * .enrich(shell("git", (ex) => ["clone", untrusted(ex.body.url), "/work"]))
 * ```
 */
export function untrusted(value: string | number | boolean): UntrustedArg {
  return { [UNTRUSTED_BRAND]: true, value: String(value) };
}

/**
 * Type guard for a marked argument.
 *
 * @internal
 */
export function isUntrusted(arg: unknown): arg is UntrustedArg {
  return (
    typeof arg === "object" &&
    arg !== null &&
    UNTRUSTED_BRAND in arg &&
    (arg as UntrustedArg)[UNTRUSTED_BRAND] === true
  );
}
