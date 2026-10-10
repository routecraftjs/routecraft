/**
 * How a thrown value reads when a tool call fails, shared by the foreground
 * tool bridge and the background settlement so the model sees the same text
 * for the same failure whichever way the tool ran.
 *
 * Neither function throws: both run while a failure is being reported, and
 * a throw there would replace the failure (a value with no string form, an
 * accessor that throws) or, on the bus, drop the settlement altogether.
 *
 * @internal
 */

/**
 * The message of a thrown value. A non-`Error` object that carries a string
 * `message` (a rejected fetch body, a plain `{ message }` literal) is read
 * for it rather than rendered as `[object Object]`.
 *
 * @internal
 */
export function errorMessage(err: unknown): string {
  try {
    if (err instanceof Error) return String(err.message);
    const message = (err as { message?: unknown } | null)?.message;
    return typeof message === "string" ? message : String(err);
  } catch {
    return `A thrown ${typeof err} that could not be read as text`;
  }
}

/**
 * Non-sensitive classifier for a thrown value. The message and stack may
 * echo the rejected tool input, so they stay inside the `_snapshot`
 * envelope; the name alone (`TypeError`, `RoutecraftError`) is persisted
 * unconditionally and is enough for a dashboard to tell failure classes
 * apart. `name` is writable, so only an identifier-shaped one is kept: a
 * class name passes, text that could carry input reads as `Error`.
 *
 * @internal
 */
export function errorName(err: unknown): string {
  try {
    if (!(err instanceof Error)) return typeof err;
    const name: unknown = err.name;
    return typeof name === "string" && CLASS_NAME.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

const CLASS_NAME = /^[A-Za-z_$][\w$]{0,63}$/;
