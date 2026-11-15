import { rcError, type RoutecraftError } from "@routecraft/routecraft";

/**
 * The error a plugin's option validation throws: `RC5003`, whether the option
 * is missing, of the wrong type or out of range. Validation runs in the plugin
 * factory, before a context exists, so nothing wraps a raw throw from there.
 *
 * @internal
 */
export function invalidOption(
  message: string,
  suggestion: string,
  cause?: unknown,
): RoutecraftError {
  return rcError("RC5003", cause, { message, suggestion });
}
