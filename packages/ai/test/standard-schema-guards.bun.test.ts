import { describe, expect, test } from "bun:test";
import { validateWithSchema } from "../src/mcp/validate-options.ts";
import { toAiInputSchema } from "../src/llm/structured-output.ts";
import { validateFnOptions } from "../src/fn/fn.ts";
import { agent } from "../src/agent/agent.ts";
import { makeFnHandlerContext } from "../src/fn/handler-context.ts";
import type { McpPluginOptions } from "../src/mcp/types.ts";
import type { FnOptions } from "../src/fn/types.ts";

/**
 * Each of this package's Standard Schema boundaries now shares one
 * predicate, `isStandardSchema`, and keeps its own refusal. These pin the
 * refusals: the shared guard moved the cast and the test, never the error
 * code or the message, which differ per boundary on purpose (#575).
 *
 * `~standard: {}` is the interesting input throughout. It is the shape that
 * carries the bag but no callable validator, so it separates a site that
 * tests the bag from one that tests the validator.
 */
describe("Standard Schema guards after adopting isStandardSchema", () => {
  const noValidator = { "~standard": {} } as never;

  /**
   * @case The MCP options validator keeps its plain Error and message
   * @preconditions validateWithSchema called with a schema carrying no callable validate
   * @expectedResult Throws the mcpPlugin-prefixed message, not an RC-coded error
   */
  test("validateWithSchema keeps its message", async () => {
    await expect(
      validateWithSchema({} as McpPluginOptions, noValidator),
    ).rejects.toThrow(
      "mcpPlugin: schema must be a StandardSchemaV1 with ~standard.validate",
    );
  });

  /**
   * @case The AI SDK bridge keeps its errorContext-prefixed message
   * @preconditions toAiInputSchema called with a schema carrying no callable validate
   * @expectedResult Throws naming the tool input schema, so the caller learns which schema was wrong
   */
  test("the AI SDK bridge keeps its message", () => {
    expect(() => toAiInputSchema(noValidator)).toThrow(
      "Tool input schema must be a StandardSchemaV1 with ~standard.validate",
    );
  });

  /**
   * @case The fn registry keeps both of its distinct refusals
   * @preconditions validateFnOptions called with a non-schema input, then with a schema-shaped input carrying no validator
   * @expectedResult Two different RC5003 messages, because they diagnose different mistakes: not a schema at all, versus a schema with no validator
   */
  test("validateFnOptions keeps both messages distinct", () => {
    const withInput = (input: unknown) => () =>
      validateFnOptions("probe", {
        description: "d",
        input,
        handler: () => undefined,
      } as unknown as FnOptions);

    expect(withInput("not a schema")).toThrow(
      /"input" is required and must be a Standard Schema value/,
    );
    expect(withInput(noValidator)).toThrow(
      /"input" must be a Standard Schema with a callable validate/,
    );
  });

  /**
   * @case A callable schema is accepted at every guarded boundary
   * @preconditions A callable schema (the shape ArkType ships) passed to each boundary this package guards
   * @expectedResult None refuses it. The guards name ArkType in their own messages, and a preliminary shape check that admitted only "object" made two of those messages false
   */
  test("accepts a callable schema at every boundary", () => {
    // The shape ArkType ships: a callable carrying the bag. Hand-rolled so
    // the test pins the shape rather than one library's implementation, and
    // so this package gains no dependency for it.
    const ark = Object.assign(() => undefined, {
      "~standard": {
        version: 1,
        vendor: "callable",
        validate: (value: unknown) => ({ value }),
        jsonSchema: { input: () => ({ type: "object" }) },
      },
    }) as never;

    expect(() =>
      validateFnOptions("probe", {
        description: "d",
        input: ark,
        handler: () => undefined,
      } as unknown as FnOptions),
    ).not.toThrow();
    expect(() => toAiInputSchema(ark as never)).not.toThrow();
    expect(() =>
      agent({
        name: "probe",
        model: "test:model",
        system: "you are a probe",
        output: ark,
      } as never),
    ).not.toThrow();
  });

  /**
   * @case The agent output guard keeps its message
   * @preconditions agent() built with an output carrying no callable validate
   * @expectedResult RC5003 naming the agent output contract; its two arms said the same thing, so collapsing them lost nothing
   */
  test("agent output keeps its message", () => {
    expect(() =>
      agent({
        name: "probe",
        model: "test:model",
        system: "you are a probe",
        output: noValidator,
      } as never),
    ).toThrow(/Agent: "output" must be a Standard Schema/);
  });

  /**
   * @case ctx.suspend keeps its schema refusal
   * @preconditions A fn handler context whose suspend is called with a schema carrying no callable validate
   * @expectedResult RC5003 naming the tool and explaining what the schema is for
   */
  test("ctx.suspend keeps its message", () => {
    const ctx = makeFnHandlerContext(
      "probe-tool",
      new AbortController().signal,
      undefined,
      {
        id: "s1",
        attempt: 1,
        deadline: undefined,
      } as never,
    );

    expect(() => ctx.suspend?.({ schema: noValidator })).toThrow(
      /ctx\.suspend in tool "probe-tool": "schema" must be a Standard Schema when given/,
    );
  });
});
