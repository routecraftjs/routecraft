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
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";

/** The `~standard` bag, as far as anything here reads it. */
export interface StandardExtension {
  vendor?: string;
  version?: number;
  jsonSchema?: { input?: unknown; output?: unknown };
}

/** Read a schema's `~standard` bag, or `undefined` when it carries none. */
export function standardExtensionOf(
  schema: StandardSchemaV1,
): StandardExtension | undefined {
  return (schema as { "~standard"?: StandardExtension })["~standard"];
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
