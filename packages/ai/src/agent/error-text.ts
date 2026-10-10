/**
 * How a thrown value reads when a tool call fails, shared by the foreground
 * tool bridge and the background settlement so the model sees the same text
 * for the same failure whichever way the tool ran.
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
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(err);
}

/**
 * Non-sensitive classifier for a thrown value. The message and stack may
 * echo the rejected tool input, so they stay inside the `_snapshot`
 * envelope; the name alone (`TypeError`, `RoutecraftError`) is safe to
 * persist unconditionally and is enough for a dashboard to tell failure
 * classes apart.
 *
 * @internal
 */
export function errorName(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}
