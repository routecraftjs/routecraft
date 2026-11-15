import { describe, expect, test } from "bun:test";
import { isRoutecraftError, rcError } from "@routecraft/routecraft";
import {
  llmPlugin,
  mcpPlugin,
  validateWithSchema,
  type LlmPluginOptions,
  type McpPluginOptions,
} from "@routecraft/ai";

const GENERIC_SUGGESTION = rcError("RC5003").meta.suggestion;

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

function expectInvalidOption(err: unknown, message: RegExp): void {
  expect(isRoutecraftError(err)).toBe(true);
  if (!isRoutecraftError(err)) return;
  expect(err.rc).toBe("RC5003");
  expect(err.message).toMatch(message);
  expect(err.meta.suggestion).not.toBe(GENERIC_SUGGESTION);
  expect(err).not.toBeInstanceOf(TypeError);
  expect(err).not.toBeInstanceOf(RangeError);
}

const mcp = (options: unknown) => () => mcpPlugin(options as McpPluginOptions);
const llm = (options: unknown) => () => llmPlugin(options as LlmPluginOptions);
const validator = () => ({ subject: "s" });

const MCP_CASES: [string, unknown, RegExp][] = [
  ["root path", { transport: "http", path: "/" }, /path must not be "\/"/],
  ["unknown traceContext", { traceContext: "sometimes" }, /traceContext/],
  ["empty name", { name: " " }, /name must not be empty/],
  ["name type", { name: 5 }, /name must be a string; got number/],
  ["relative path", { transport: "http", path: "no-slash" }, /invalid path/],
  ["auth type", { transport: "http", auth: 5 }, /auth must be an options/],
  [
    "pins shape",
    { clients: { a: { url: "https://x.test", pins: { added: "nope" } } } },
    /pins must be an object/,
  ],
  [
    "enabled type",
    { clients: { a: { url: "https://x.test", enabled: 5 } } },
    /enabled must be true, false/,
  ],
  ["removed proxy", { proxy: {} }, /`proxy` was removed/],
  ["removed port", { transport: "http", port: 1 }, /`port` and `host`/],
  ["empty server", { transport: "http", server: "" }, /server name/],
  ["cors origin", { transport: "http", cors: { origin: 4 } }, /cors\.origin/],
  ["old oauth shape", { auth: { provider: {} } }, /removed OAuth/],
  ["validator type", { auth: { validator: "no" } }, /got string/],
  ["no validator", { auth: {} }, /must have a 'validator'/],
  [
    "scopes type",
    { auth: { validator, requiredScopes: "a" } },
    /requiredScopes must be an array.*got string/,
  ],
  [
    "scope token",
    { auth: { validator, requiredScopes: ["a b"] } },
    /invalid scope/,
  ],
  [
    "clock tolerance",
    { auth: { validator, clockToleranceSec: -1 } },
    /clockToleranceSec.*got -1/,
  ],
  [
    "stdio command",
    { clients: { bad: { transport: "stdio", command: "" } } },
    /non-empty command/,
  ],
  ["maxRestarts", { maxRestarts: -1 }, /maxRestarts.*got -1/],
  ["restartDelay", { restartDelay: "soon" }, /restartDelay/],
  [
    "restartBackoffMultiplier",
    { restartBackoffMultiplier: 0.5 },
    /restartBackoffMultiplier.*got 0\.5/,
  ],
  ["toolRefreshInterval", { toolRefreshInterval: "x" }, /toolRefreshInterval/],
];

const LLM_CASES: [string, unknown, RegExp][] = [
  ["options", null, /options must be an object; got null/],
  ["providers", {}, /options\.providers must be an object/],
  ["provider entry", { providers: { openai: 3 } }, /must be an object/],
  ["unknown provider", { providers: { acme: {} } }, /not a supported/],
  ["api key", { providers: { openai: {} } }, /apiKey is required/],
  [
    "custom model shape",
    { providers: { custom: { model: {} } } },
    /is not an AI SDK language model.*doGenerate/,
  ],
  [
    "keyed baseURL",
    { providers: { openai: { apiKey: "k", baseURL: 1 } } },
    /baseURL must be a string/,
  ],
  [
    "local baseURL",
    { providers: { ollama: { baseURL: 1 } } },
    /baseURL must be a string/,
  ],
  ["modelId", { providers: { ollama: { modelId: " " } } }, /modelId/],
  [
    "lmstudio apiKey",
    { providers: { lmstudio: { apiKey: 1 } } },
    /apiKey must be a string/,
  ],
  ["custom model", { providers: { custom: { model: 1 } } }, /model must be/],
  [
    "defaultOptions",
    { providers: {}, defaultOptions: 1 },
    /defaultOptions must be an object/,
  ],
];

describe("plugin option validation", () => {
  /**
   * @case Every refusal in mcpPlugin's option validation is a coded error
   * @preconditions One invalid option per validation site
   * @expectedResult RC5003 with the original message and a suggestion, never a TypeError or RangeError
   */
  test.each(MCP_CASES)("mcpPlugin: %s", (_name, options, message) => {
    expectInvalidOption(thrownBy(mcp(options)), message);
  });

  /**
   * @case Every refusal in llmPlugin's option validation is a coded error
   * @preconditions One invalid option per validation site
   * @expectedResult RC5003 with the original message and a suggestion, never a TypeError
   */
  test.each(LLM_CASES)("llmPlugin: %s", (_name, options, message) => {
    expectInvalidOption(thrownBy(llm(options)), message);
  });

  /**
   * @case validateWithSchema refuses a non-schema and a failing schema with a coded error
   * @preconditions A plain object as schema, then a schema that reports an issue
   * @expectedResult Both rejections are RC5003 with a suggestion
   */
  test("validateWithSchema rejections are coded", async () => {
    const notASchema = await validateWithSchema({}, {} as never).catch(
      (err: unknown) => err,
    );
    expectInvalidOption(notASchema, /schema must be a StandardSchemaV1/);

    const failing = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: () => ({ issues: [{ message: "nope" }] }),
      },
    };
    const refused = await validateWithSchema({}, failing).catch(
      (err: unknown) => err,
    );
    expectInvalidOption(refused, /options validation failed: .*nope/);
  });
});
