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
  if (options === null || typeof options !== "object") {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: fn "${id}" entry must be an object with description, schema, and handler.`,
    });
  }
  if (
    typeof options.description !== "string" ||
    options.description.trim() === ""
  ) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: fn "${id}" is missing a non-empty "description".`,
    });
  }
  if (
    options.schema === null ||
    typeof options.schema !== "object" ||
    typeof (options.schema as { ["~standard"]?: unknown })["~standard"] !==
      "object"
  ) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: fn "${id}" "schema" is required and must be a Standard Schema value (Zod/Valibot/ArkType/etc.).`,
    });
  }
  const standard = (
    options.schema as { ["~standard"]?: { validate?: unknown } }
  )["~standard"];
  if (typeof standard?.validate !== "function") {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: fn "${id}" "schema" must be a Standard Schema with a callable validate.`,
    });
  }
  if (typeof options.handler !== "function") {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: fn "${id}" "handler" is required and must be a function.`,
    });
  }
  if (options.tags !== undefined) {
    if (!Array.isArray(options.tags)) {
      throw rcError("RC5003", undefined, {
        message: `agentPlugin: fn "${id}" "tags" must be an array of non-empty strings.`,
      });
    }
    for (const t of options.tags) {
      if (typeof t !== "string" || t.trim() === "") {
        throw rcError("RC5003", undefined, {
          message: `agentPlugin: fn "${id}" "tags" must contain only non-empty strings.`,
        });
      }
    }
  }
}
