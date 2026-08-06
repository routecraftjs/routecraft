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
 * @internal
 */
export function staticSourcePathError(adapter: string): Error {
  return new Error(
    `${adapter} adapter: the source role requires a static string path (dynamic paths resolve against an exchange, which does not exist at subscribe time)`,
  );
}
