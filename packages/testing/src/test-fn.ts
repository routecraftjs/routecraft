import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  formatSchemaIssues,
  logger as defaultLogger,
  rcError,
} from "@routecraft/routecraft";

/**
 * Structural shape of a fn-like spec for testing. Does not import
 * `FnOptions` from `@routecraft/ai` so this package stays free of
 * a reverse dependency. Real `FnOptions` values are structurally
 * assignable here -- the extra `description` field is ignored.
 *
 * @beta
 */
export interface TestFnSpec<TIn, TOut> {
  schema: StandardSchemaV1<TIn>;
  handler: (input: TIn, ctx: TestFnHandlerContext) => Promise<TOut> | TOut;
}

/**
 * Synthetic context handed to a fn handler under `testFn`. Mirrors the
 * minimum shape `agentPlugin` provides at production dispatch time
 * (without coupling to that implementation). Extra fields a handler may
 * read at runtime can be added here in follow-ups without breaking the
 * structural contract.
 *
 * @beta
 */
export interface TestFnHandlerContext {
  logger: ReturnType<typeof defaultLogger.child>;
  abortSignal: AbortSignal;
}

/**
 * Options for {@link testFn}.
 *
 * @beta
 */
export interface TestFnOptions {
  /** Caller-supplied abort signal. Defaults to a never-firing signal. */
  signal?: AbortSignal;
  /** Caller-supplied logger. Defaults to a child of the framework logger bound to `{ test: "fn" }`. */
  logger?: ReturnType<typeof defaultLogger.child>;
}

/**
 * Run a fn-like spec end-to-end in tests. Validates `input` against the
 * spec's Standard Schema, then calls the handler with a synthetic
 * context. Designed to mirror what `agentPlugin` does internally at
 * production dispatch time, without exposing or depending on that
 * dispatcher.
 *
 * Throws `RC5002` (Validation failed) if the input does not pass the
 * schema. Errors thrown from the handler propagate as-is.
 *
 * @beta
 *
 * @example
 * ```typescript
 * import { testFn } from "@routecraft/testing";
 * import { z } from "zod";
 *
 * const greet = {
 *   description: "...",
 *   schema: z.object({ name: z.string() }),
 *   handler: async (input, ctx) => `hello ${input.name}`,
 * };
 *
 * const out = await testFn(greet, { name: "alice" });
 * expect(out).toBe("hello alice");
 * ```
 */
export async function testFn<TIn, TOut>(
  spec: TestFnSpec<TIn, TOut>,
  input: unknown,
  options: TestFnOptions = {},
): Promise<TOut> {
  const standard = (spec.schema as { ["~standard"]?: { validate?: unknown } })[
    "~standard"
  ];
  if (typeof standard?.validate !== "function") {
    throw rcError("RC5003", undefined, {
      message: `testFn: spec.schema must be a Standard Schema with a callable validate.`,
    });
  }

  const validate = standard.validate as (
    value: unknown,
  ) =>
    | { value?: unknown; issues?: unknown }
    | Promise<{ value?: unknown; issues?: unknown }>;
  let result = validate(input);
  if (result instanceof Promise) result = await result;
  if (result.issues !== undefined && result.issues !== null) {
    throw rcError("RC5002", undefined, {
      message: `testFn: input validation failed: ${formatSchemaIssues(result.issues)}`,
    });
  }

  const ctx: TestFnHandlerContext = {
    logger: options.logger ?? defaultLogger.child({ test: "fn" }),
    abortSignal: options.signal ?? new AbortController().signal,
  };

  const validated = "value" in result ? (result.value as TIn) : (input as TIn);
  return (await spec.handler(validated, ctx)) as TOut;
}
