/**
 * Reading the non-standard `~standard.jsonSchema` extension.
 *
 * Standard Schema itself defines no JSON Schema export, so everything here
 * is opportunistic: Zod, ArkType and the AI SDK bridge expose the extension,
 * and a library without it yields nothing while nothing else changes.
 *
 * Two callers share it for different reasons. The suspension descriptor
 * (`suspension/hash.ts`) folds the rendering into `continuationHash` so a
 * schema edited under a parked exchange is caught. The ops management API
 * publishes it so an operator can see what a route accepts without reading
 * the source.
 *
 * The dialect is a required argument rather than a default here, because
 * one of those callers hashes what comes back: a default changed in this
 * module would change every stored digest without a line of suspension code
 * moving. Each caller pins its own constant and passes it.
 *
 * The module also holds `isStandardSchema`, which reads the same bag for a
 * callable `validate` rather than for the JSON Schema arms.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";

/** The `~standard` bag, as far as anything here reads it. */
export interface StandardExtension {
  vendor?: string;
  version?: number;
  validate?: unknown;
  jsonSchema?: { input?: unknown; output?: unknown };
}

/**
 * Read a schema's `~standard` bag, or `undefined` when it carries none.
 *
 * Functions count. An ArkType schema is a callable object carrying the bag,
 * and `validate()` works on one, so a test that admitted only `"object"`
 * was narrower than the validation it feeds.
 */
export function standardExtensionOf(
  schema: unknown,
): StandardExtension | undefined {
  if (
    schema === null ||
    (typeof schema !== "object" && typeof schema !== "function")
  ) {
    return undefined;
  }
  return (schema as { "~standard"?: StandardExtension })["~standard"];
}

/**
 * Whether a value is a Standard Schema carrying a callable validator.
 *
 * The check every validation boundary has to make before handing a
 * caller-supplied value to `validateAgainst`, which dereferences
 * `~standard.validate` without guarding. Seven sites hand-rolled the same
 * index cast and predicate before this existed (#575).
 *
 * Deliberately only the predicate: the refusal stays with the caller,
 * because the error code and message differ per boundary on purpose. A
 * plugin option validator throws a plain `Error` for its own message, the
 * fn registry throws `RC5003` naming the fn, and the structured-text
 * fallback declines to a `undefined` rather than throwing at all.
 *
 * @param value - Any value, typically arriving from user configuration
 * @returns Whether `value["~standard"].validate` is callable. That is all it
 *   proves: `version` and `vendor` are spec-required but not checked, and
 *   the local `StandardExtension` treats both as optional because schemas
 *   omitting them reach the framework in practice. A caller that reads
 *   either should still guard it.
 *
 * @example
 * ```ts
 * if (!isStandardSchema(schema)) {
 *   throw new Error("options.schema must be a Standard Schema");
 * }
 * const result = await validateAgainst(schema, value);
 * ```
 */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return typeof standardExtensionOf(value)?.validate === "function";
}

/**
 * Resolve one arm of the extension to a rendered JSON Schema.
 *
 * The arm is either the rendered schema or a producer for it (Zod 4 ships
 * the lazy form). A producer is vendor code, so a throwing one yields no
 * rendering rather than propagating: the rendering is descriptive, and the
 * live schema is what validation actually runs against.
 *
 * A producer is called with the spec's options first and then, if that
 * throws, with none. Standard JSON Schema types both arms as
 * `(options: { target }) => ...`, so an implementation is entitled to read
 * `options.target` and throw without it; the second attempt covers one
 * predating the options argument.
 *
 * @internal
 */
export function renderJsonSchemaArm(arm: unknown, target: string): unknown {
  if (arm === undefined || arm === null) return undefined;
  if (typeof arm !== "function") return arm;
  const producer = arm as (options?: { target: string }) => unknown;
  for (const call of [() => producer({ target }), () => producer()]) {
    try {
      const produced = call();
      if (produced !== null && produced !== undefined) return produced;
    } catch {
      // Try the next calling convention; an arm that yields nothing at all
      // is the caller's business to report, not this function's.
    }
  }
  return undefined;
}
