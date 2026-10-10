import { describe, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import { agentPlugin, fn } from "../src/index.ts";
import type { FnOptions } from "../src/index.ts";
import type { FnEntry } from "../src/agent/tools/types.ts";

/**
 * Type-level tests: `fn()` types a handler by its own input schema, and
 * the result still fits the heterogeneous `functions` record (#727).
 */
describe("fn() type safety", () => {
  /**
   * @case Two eager fns with different schemas share one functions record
   * @preconditions agentPlugin({ functions: { a: fn({ input: A }), b: fn({ input: B }) } }) with A and B unrelated
   * @expectedResult Each handler's input is its own schema's output and nothing else; the record compiles without casts
   */
  test("each fn in a functions record sees only its own schema output", () => {
    agentPlugin({
      functions: {
        lookupCustomer: fn({
          description: "Look up a customer",
          input: z.object({ email: z.string() }),
          handler: async (input) => {
            expectTypeOf(input).toEqualTypeOf<{ email: string }>();
            return input.email;
          },
        }),
        postBrief: fn({
          description: "Post an internal brief",
          input: z.object({ channel: z.string(), priority: z.number() }),
          handler: async (input, ctx) => {
            expectTypeOf(input).toEqualTypeOf<{
              channel: string;
              priority: number;
            }>();
            ctx.logger.info({ channel: input.channel }, "posting");
            return { ok: true as const };
          },
        }),
      },
    });
  });

  /**
   * @case A schema with .transform() types the handler by its output, not its raw input
   * @preconditions fn({ input: z.object({ n: z.string().transform(Number) }) })
   * @expectedResult The handler receives { n: number }
   */
  test("a transforming schema gives the handler InferOutput, not the raw input", () => {
    fn({
      description: "Parses a count",
      input: z.object({ n: z.string().transform(Number) }),
      handler: async (input) => {
        expectTypeOf(input).toEqualTypeOf<{ n: number }>();
        return input.n;
      },
    });
  });

  /**
   * @case fn() returns FnOptions of the schema output and the handler result
   * @preconditions fn({ input: z.object({ q: z.string() }), handler: async () => 1 })
   * @expectedResult The value is FnOptions<{ q: string }, number> and assignable to FnEntry
   */
  test("fn() returns FnOptions typed by the schema and the handler", () => {
    const spec = fn({
      description: "Counts",
      input: z.object({ q: z.string() }),
      handler: async (input) => input.q.length,
    });
    expectTypeOf(spec).toEqualTypeOf<FnOptions<{ q: string }, number>>();
    expectTypeOf(spec).toMatchTypeOf<FnEntry>();
  });

  /**
   * @case A handler that reads a field the schema does not declare is rejected
   * @preconditions fn({ input: z.object({ q: z.string() }), handler: (input) => input.missing })
   * @expectedResult The read is a compile error, so the schema is the handler's contract
   */
  test("a field outside the schema does not compile", () => {
    fn({
      description: "Reads off the schema",
      input: z.object({ q: z.string() }),
      // @ts-expect-error the schema declares no `missing` field
      handler: async (input) => input.missing,
    });
  });

  /**
   * @case A handler annotated narrower than its schema's output is rejected, written by hand or through fn()
   * @preconditions A schema whose q is optional; an annotated FnOptions and a fn() call, each with a handler that declares (input: { q: string })
   * @expectedResult Both are compile errors, because the handler is a property checked contravariantly; the erasure lives only on the registry's RegisteredFn
   */
  test("a handler narrower than the schema output does not compile", () => {
    const annotated: FnOptions<{ q?: string | undefined }> = {
      description: "Reads q",
      input: z.object({ q: z.string().optional() }),
      // @ts-expect-error q may be absent, so a handler that requires it is unsound
      handler: async (input: { q: string }) => input.q.length,
    };
    fn({
      description: "Reads q",
      input: z.object({ q: z.string().optional() }),
      // @ts-expect-error q may be absent, so a handler that requires it is unsound
      handler: async (input: { q: string }) => input.q.length,
    });
    expectTypeOf(annotated).toMatchTypeOf<FnEntry>();
  });
});
