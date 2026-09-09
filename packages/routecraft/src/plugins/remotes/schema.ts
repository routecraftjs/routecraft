import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Wrap a JSON Schema the remote rendered as a Standard Schema.
 *
 * The result is the discovery bundle a local route would have declared,
 * so nothing downstream learns that the schema came from a remote: the
 * ops listing renders it back through the same `~standard.jsonSchema`
 * arms it reads for a Zod schema, and the agent tool bridge hands it to
 * the model provider the way it hands an MCP tool's.
 *
 * Validation is a pass-through on purpose. The remote validates at its
 * own door against the live schema, and a second validation here against
 * a rendering would add latency and, the day the two disagree, refuse
 * what the remote accepts.
 */
export function standardSchemaFromJsonSchema(
  schema: unknown,
): StandardSchemaV1<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "routecraft",
      validate(value) {
        return { value };
      },
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
    } as StandardSchemaV1<unknown, unknown>["~standard"],
  };
}
