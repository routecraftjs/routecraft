import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  formatSchemaIssues,
  logger as defaultLogger,
  parseDuration,
  rcError,
  type Duration,
} from "@routecraft/routecraft";

/**
 * Structural shape of a fn-like spec for testing. Does not import
 * `FnOptions` from `@routecraft/ai` so this package stays free of
 * a reverse dependency. Real `FnOptions` values are structurally
 * assignable here -- the extra `description` field is ignored.
 */
export interface TestFnSpec<TIn, TOut> {
  /** Schema whose validated/coerced output is passed to `handler`. */
  input: StandardSchemaV1<unknown, TIn>;
  handler: (input: TIn, ctx: TestFnHandlerContext) => Promise<TOut> | TOut;
}

/**
 * Synthetic context handed to a fn handler under `testFn`. Mirrors the
 * minimum shape `agentPlugin` provides at production dispatch time
 * (without coupling to that implementation). Extra fields a handler may
 * read at runtime can be added here in follow-ups without breaking the
 * structural contract.
 */
export interface TestFnHandlerContext {
  logger: ReturnType<typeof defaultLogger.child>;
  abortSignal: AbortSignal;
  /**
   * Structural twin of the production `ctx.suspend`: returns a sentinel
   * shaped like the one the agent runtime parks on, so a unit test can
   * assert that a handler asked to suspend (and with what) without
   * standing up an agent loop. Nothing is parked under `testFn`; drive the
   * handler through a route to exercise the durable path.
   */
  suspend: (options?: TestFnSuspendOptions) => TestFnSuspendSentinel;
}

/**
 * Structural twin of the agent tier's suspend options. Kept structural so
 * this package carries no dependency on `@routecraft/ai`; a real
 * `AgentSuspendOptions` value satisfies it.
 */
export interface TestFnSuspendOptions {
  schema?: StandardSchemaV1;
  ttl?: Duration;
  meta?: unknown;
}

/**
 * What {@link TestFnHandlerContext.suspend} returns: the same structural
 * shape as the agent runtime's sentinel, carrying the request back to the
 * test for assertion.
 */
export interface TestFnSuspendSentinel {
  readonly status: "suspend-requested";
  readonly request: TestFnSuspendOptions;
}

/**
 * Options for {@link testFn}.
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
 * @example
 * ```typescript
 * import { testFn } from "@routecraft/testing";
 * import { z } from "zod";
 *
 * const greet = {
 *   description: "...",
 *   input: z.object({ name: z.string() }),
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
  const standard = (spec.input as { ["~standard"]?: { validate?: unknown } })[
    "~standard"
  ];
  if (typeof standard?.validate !== "function") {
    throw rcError("RC5003", undefined, {
      message: `testFn: spec.input must be a Standard Schema with a callable validate.`,
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
    suspend: (suspendOptions) => {
      // Same refusal as the production ctx.suspend (RC5003 from
      // makeSuspend), so a handler exercised in isolation cannot pass with
      // a suspension request the agent runtime would reject.
      if (suspendOptions?.schema !== undefined) {
        const validate = (
          suspendOptions.schema as { ["~standard"]?: { validate?: unknown } }
        )?.["~standard"]?.validate;
        if (typeof validate !== "function") {
          throw rcError("RC5003", undefined, {
            message:
              'testFn: ctx.suspend "schema" must be a Standard Schema when given. It renders what a valid resume payload looks like on the Suspended acknowledgment. Omit it entirely to declare no contract.',
          });
        }
      }
      if (suspendOptions?.ttl !== undefined) {
        parseDuration(suspendOptions.ttl, "testFn: ctx.suspend({ ttl })");
      }
      return {
        status: "suspend-requested",
        request: suspendOptions ?? {},
      };
    },
  };

  const validated = "value" in result ? (result.value as TIn) : (input as TIn);
  return (await spec.handler(validated, ctx)) as TOut;
}
