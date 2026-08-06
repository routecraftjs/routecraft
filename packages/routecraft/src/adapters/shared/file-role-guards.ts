import { rcError } from "../../error.ts";

/**
 * Enforces the mutually-exclusive send-behavior law for file-role adapters
 * (`append: true` and `delete: true` cannot be combined). Called from the
 * destination adapter constructors; the factories construct their
 * destination eagerly, so the error still surfaces at factory-call time
 * while the factory itself stays "construction only" per
 * `.standards/adapter-architecture.md`.
 *
 * @internal
 */
export function assertExclusiveSendBehavior(
  adapter: string,
  options: { append?: boolean; delete?: boolean },
): void {
  if (options.append && options.delete) {
    throw rcError("RC5003", undefined, {
      message: `${adapter} adapter: \`append\` and \`delete\` are mutually exclusive send behaviors`,
      suggestion: "Pass at most one of `append: true` / `delete: true`",
    });
  }
}

/**
 * The single error for using a dynamic (function) `path` in the source
 * role, shared by every file-family adapter so the message cannot drift.
 *
 * Coded like every other adapter-role rejection so callers can classify it
 * programmatically, even though it is thrown lazily from `subscribe` rather
 * than at construction (a dynamic path is legal for send and fetch, so the
 * factory cannot reject it up front).
 *
 * @internal
 */
export function staticSourcePathError(adapter: string): Error {
  return rcError("RC5003", undefined, {
    message: `${adapter} adapter: the source role requires a static string path (dynamic paths resolve against an exchange, which does not exist at subscribe time)`,
    suggestion:
      "Pass a string `path` to `.from()`, or keep the function path and use the send / fetch roles (`.to()` / `.enrich()`)",
  });
}

/**
 * Decides whether a `path` option selects the file roles, for the factories
 * whose call shapes are discriminated by its presence (`json`, `html`: a
 * transformer without a path, file roles with one).
 *
 * Presence means "the key was supplied", so an empty string is a supplied
 * path, not an absent one. Left to truthiness, `path: ""` would silently
 * hand back a transformer that ignores every file option the caller passed;
 * a template that resolved to nothing would fail as a confusing type error
 * downstream instead of at the call. Reject it here.
 *
 * @param adapter - Factory name, for the error message
 * @param path - The `path` option as supplied
 * @returns `true` when the file roles apply, `false` for the transformer role
 * @internal
 */
export function selectsFileRole(adapter: string, path: unknown): boolean {
  if (path === undefined) return false;
  if (typeof path === "string" && path.length === 0) {
    throw rcError("RC5003", undefined, {
      message: `${adapter} adapter: \`path\` is an empty string`,
      suggestion: `Pass a real file path to use the file roles, or omit \`path\` entirely for the transformer role`,
    });
  }
  return true;
}
