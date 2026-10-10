import { isStandardSchema, rcError } from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FnDefinition, FnOptions } from "./types.ts";

/**
 * Author a fn whose handler is typed by its own input schema.
 *
 * `agentPlugin({ functions })` holds fns of unrelated shapes in one record,
 * so an entry written as a bare object literal, or annotated `FnOptions`,
 * hands its handler `unknown`. Wrapping the entry in `fn()` gives it an
 * inference boundary of its own: the schema's output type (after any
 * `.transform()`) is the handler's input type, with nothing to annotate.
 *
 * Runtime behaviour is unchanged; the value is returned as given.
 *
 * @example
 * ```ts
 * agentPlugin({
 *   functions: {
 *     sendSlackMessage: fn({
 *       description: "Post a message to a Slack channel",
 *       input: z.object({ channel: z.string(), text: z.string() }),
 *       handler: async (input, ctx) => {
 *         ctx.logger.info({ channel: input.channel }, "Posting to Slack");
 *         return { ok: true };
 *       },
 *     }),
 *   },
 * });
 * ```
 *
 * @param definition - Description, input schema, handler and optional tags
 * @returns The same object, typed as `FnOptions` of the schema's output
 * @template S - The input schema
 * @template TOut - Handler return type
 */
export function fn<S extends StandardSchemaV1, TOut>(
  definition: FnDefinition<S, TOut>,
): FnOptions<StandardSchemaV1.InferOutput<S>, TOut> {
  return definition;
}

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
      message: `agentPlugin: fn "${id}" entry must be an object with description, input, and handler.`,
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
  // A callable counts: an ArkType schema is a function carrying the bag, and
  // this message names ArkType among the libraries it accepts.
  if (
    options.input === null ||
    (typeof options.input !== "object" &&
      typeof options.input !== "function") ||
    typeof (options.input as { ["~standard"]?: unknown })["~standard"] !==
      "object"
  ) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: fn "${id}" "input" is required and must be a Standard Schema value (Zod/Valibot/ArkType/etc.).`,
    });
  }
  if (!isStandardSchema(options.input)) {
    throw rcError("RC5003", undefined, {
      message: `agentPlugin: fn "${id}" "input" must be a Standard Schema with a callable validate.`,
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
    for (let i = 0; i < options.tags.length; i++) {
      const t = options.tags[i];
      if (typeof t !== "string" || t.trim() === "") {
        throw rcError("RC5003", undefined, {
          message: `agentPlugin: fn "${id}" "tags" must contain only non-empty strings.`,
        });
      }
      // Normalise: trim surrounding whitespace so exact selectors match.
      options.tags[i] = t.trim();
    }
  }
}
