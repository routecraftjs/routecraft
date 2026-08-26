import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { thenableSchema } from "@routecraft/testing";
import { validateWithSchema } from "../src/mcp/validate-options.ts";
import { toAiInputSchema } from "../src/llm/structured-output.ts";
import type { McpPluginOptions } from "../src/mcp/types.ts";

/**
 * The two schema boundaries this package owns, held to the thenable
 * contract (see `validateAgainst` for what the contract costs).
 *
 * The MCP options validator reaches the shared helper. The AI SDK bridge
 * does not, because `jsonSchema({ validate })` is a synchronous seam that
 * has to refuse asynchrony rather than await it, so it carries its own check.
 */
describe("schema returning a thenable", () => {
  const rejecting = () =>
    thenableSchema<number>({
      issues: [{ message: "expected number" }],
    }) as StandardSchemaV1;

  /** A schema with the JSON Schema the bridge needs, over a given validate(). */
  const bridge = (validate: StandardSchemaV1["~standard"]["validate"]) =>
    toAiInputSchema({
      "~standard": {
        version: 1,
        vendor: "test",
        jsonSchema: {
          input: () => ({
            type: "object",
            properties: { n: { type: "number" } },
          }),
        },
        validate,
      },
    } as unknown as StandardSchemaV1) as {
      validate: (
        value: unknown,
      ) => { success: true; value: unknown } | { success: false; error: Error };
    };

  /**
   * @case validateWithSchema rejects options a thenable schema refused
   * @preconditions mcpPlugin options validated with a schema whose validate() returns a rejecting non-Promise thenable
   * @expectedResult It throws with the schema's message, instead of returning the unvalidated options
   */
  test("the MCP options validator throws on it", async () => {
    await expect(
      validateWithSchema({} as McpPluginOptions, rejecting()),
    ).rejects.toThrow(/mcpPlugin options validation failed: .*expected number/);
  });

  /**
   * @case The AI SDK bridge fails an empty issue list rather than passing it
   * @preconditions A tool input schema whose validate() returns `{ issues: [] }` synchronously
   * @expectedResult validate reports failure, not `{ success: true, value: undefined }`: present issues mean failure whether or not the schema said why, matching validateAgainst
   */
  test("the AI SDK bridge fails an empty issue list", () => {
    const bridged = bridge(() => ({ issues: [] }));

    const result = bridged.validate({ n: 1 });

    expect(result.success).toBe(false);
  });

  /**
   * @case The AI SDK bridge refuses a thenable instead of passing it
   * @preconditions A tool input schema whose validate() returns a non-Promise thenable
   * @expectedResult validate reports failure with the async refusal, rather than success with an undefined value
   */
  test("the AI SDK bridge refuses it", () => {
    const bridged = bridge(rejecting()["~standard"].validate);

    const result = bridged.validate({ n: 1 });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error.message).toContain(
      "async schema validation is not supported",
    );
  });
});
