import { rcError } from "@routecraft/routecraft";
import type { FnOptions } from "./types.ts";

/**
 * Validate a fn's config shape. Run at context init (not at authoring
 * time) so authoring `{ ... } satisfies FnOptions` stays ergonomic and
 * misconfiguration surfaces with a helpful RC5003 error at startup.
 *
 * @internal
 */
export function validateFnOptions(id: string, options: FnOptions): void {
  if (
    typeof options.description !== "string" ||
    options.description.trim() === ""
  ) {
    throw rcError("RC5003", undefined, {
      message: `fn "${id}": "description" is required and must be a non-empty string.`,
    });
  }
  if (
    options.schema === null ||
    typeof options.schema !== "object" ||
    typeof (options.schema as { ["~standard"]?: unknown })["~standard"] !==
      "object"
  ) {
    throw rcError("RC5003", undefined, {
      message: `fn "${id}": "schema" is required and must be a Standard Schema value (Zod/Valibot/ArkType/etc.).`,
    });
  }
  if (typeof options.handler !== "function") {
    throw rcError("RC5003", undefined, {
      message: `fn "${id}": "handler" is required and must be a function.`,
    });
  }
}
