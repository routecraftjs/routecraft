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
 * Presence means "the key was SUPPLIED", never "the key holds something
 * truthy". Two shapes are supplied-but-empty and both are refused:
 *
 * - `path: ""`, from a template that resolved to nothing.
 * - `path: undefined`, from options built programmatically
 *   (`json({ ...cfg })` where `cfg.path` is `string | undefined`).
 *
 * The second is the absence-axis twin of the widened-boolean hazard that
 * bans `chunked: someBoolean`: the call means "file adapter, path from
 * config", and silently demoting it to a transformer would produce an
 * adapter that ignores every file option alongside it and fails far from the
 * cause. Only an OMITTED key selects the transformer role.
 *
 * @param adapter - Factory name, for the error message
 * @param options - Options object as supplied, tested for the key itself
 * @returns `true` when the file roles apply, `false` for the transformer role
 * @internal
 */
export function selectsFileRole(adapter: string, options: object): boolean {
  // Own property, not `in`: an inherited `path` (a class instance, an object
  // built with Object.create) was not supplied by this caller and must not
  // reclassify the adapter.
  if (!Object.prototype.hasOwnProperty.call(options, "path")) return false;
  const path = (options as { path?: unknown }).path;
  if (path === undefined) {
    throw rcError("RC5003", undefined, {
      message: `${adapter} adapter: \`path\` was supplied but is undefined`,
      suggestion: `Omit \`path\` entirely for the transformer role, or resolve it before the call (e.g. cfg.path ?? throwIfMissing()) to use the file roles`,
    });
  }
  if (typeof path === "string" && path.length === 0) {
    throw rcError("RC5003", undefined, {
      message: `${adapter} adapter: \`path\` is an empty string`,
      suggestion: `Pass a real file path to use the file roles, or omit \`path\` entirely for the transformer role`,
    });
  }
  return true;
}
