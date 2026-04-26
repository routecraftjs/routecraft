import { describe, test, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { ContextBuilder, isRoutecraftError } from "@routecraft/routecraft";
import { testContext, testFn, type TestContext } from "@routecraft/testing";
import {
  ADAPTER_FN_REGISTRY,
  agentPlugin,
  type FnOptions,
} from "../src/index.ts";

describe("fn registration via agentPlugin", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case agentPlugin populates ADAPTER_FN_REGISTRY from the functions record
   * @preconditions agentPlugin({ functions: { currentTime: {...} } })
   * @expectedResult ADAPTER_FN_REGISTRY store contains the registered entry keyed by id
   */
  test("agentPlugin populates ADAPTER_FN_REGISTRY from the functions record", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              currentTime: {
                description: "Current UTC timestamp in ISO 8601",
                input: z.object({}),
                handler: async () => new Date().toISOString(),
              },
            },
          }),
        ],
      })
      .build();

    const registry = t.ctx.getStore(ADAPTER_FN_REGISTRY);
    expect(registry).toBeInstanceOf(Map);
    expect(registry?.has("currentTime")).toBe(true);
    expect((registry?.get("currentTime") as FnOptions).description).toBe(
      "Current UTC timestamp in ISO 8601",
    );
  });

  /**
   * @case agentPlugin throws at init when a fn entry is missing its description
   * @preconditions functions entry without description
   * @expectedResult build() rejects with RC5003 mentioning description
   */
  test("agentPlugin throws when a fn entry has no description", async () => {
    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            agentPlugin({
              functions: {
                broken: {
                  input: z.object({}),
                  handler: async () => 1,
                } as unknown as FnOptions,
              },
            }),
          ],
        })
        .build(),
    ).rejects.toThrow(/description/i);
  });

  /**
   * @case agentPlugin throws at init when a fn entry has a non-Standard-Schema schema
   * @preconditions functions entry with schema lacking ~standard.validate
   * @expectedResult build() rejects with RC5003 about callable validate
   */
  test("agentPlugin throws when a fn schema is not a Standard Schema", async () => {
    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            agentPlugin({
              functions: {
                bad: {
                  description: "x",
                  input: {
                    "~standard": { validate: "not-a-function" },
                  } as unknown as FnOptions["input"],
                  handler: async () => 1,
                } satisfies FnOptions,
              },
            }),
          ],
        })
        .build(),
    ).rejects.toThrow(/validate/i);
  });

  /**
   * @case agentPlugin throws on duplicate fn id across installs
   * @preconditions Two agentPlugin installs register the same fn id
   * @expectedResult build() rejects naming the duplicate fn id
   */
  test("agentPlugin throws on duplicate fn id across installs", async () => {
    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            agentPlugin({
              functions: {
                dup: {
                  description: "first",
                  input: z.object({}),
                  handler: async () => 1,
                },
              },
            }),
            agentPlugin({
              functions: {
                dup: {
                  description: "second",
                  input: z.object({}),
                  handler: async () => 2,
                },
              },
            }),
          ],
        })
        .build(),
    ).rejects.toThrow(/dup/);
  });

  /**
   * @case Empty fn id key throws at init
   * @preconditions agentPlugin with a blank-string id key
   * @expectedResult build() rejects with a message about the fn id
   */
  test("agentPlugin throws on empty fn id key", async () => {
    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            agentPlugin({
              functions: {
                "  ": {
                  description: "x",
                  input: z.object({}),
                  handler: async () => 1,
                },
              },
            }),
          ],
        })
        .build(),
    ).rejects.toThrow(/id/i);
  });

  /**
   * @case Fn with tags is registered with tags preserved on the registry entry
   * @preconditions agentPlugin functions entry with tags: ["read-only", "data"]
   * @expectedResult Registry entry exposes the same tags array
   */
  test("agentPlugin preserves fn tags on the registry entry", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              currentTime: {
                description: "Current UTC ISO 8601 timestamp.",
                input: z.object({}),
                handler: async () => new Date().toISOString(),
                tags: ["read-only", "idempotent"],
              },
            },
          }),
        ],
      })
      .build();

    const entry = t.ctx.getStore(ADAPTER_FN_REGISTRY)?.get("currentTime") as
      | FnOptions
      | undefined;
    expect(entry?.tags).toEqual(["read-only", "idempotent"]);
  });

  /**
   * @case Fn tags must be a non-empty-string array
   * @preconditions agentPlugin functions entry with tags: ["read-only", ""]
   * @expectedResult build() rejects with RC5003 mentioning tags
   */
  test("agentPlugin throws when a fn tag is empty", async () => {
    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            agentPlugin({
              functions: {
                bad: {
                  description: "x",
                  input: z.object({}),
                  handler: async () => 1,
                  tags: ["read-only", ""],
                },
              },
            }),
          ],
        })
        .build(),
    ).rejects.toThrow(/tags/i);
  });

  /**
   * @case Fn tags must be an array (not a string)
   * @preconditions agentPlugin functions entry with tags: "read-only" cast to any
   * @expectedResult build() rejects with RC5003 mentioning tags
   */
  test("agentPlugin throws when fn tags is not an array", async () => {
    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            agentPlugin({
              functions: {
                bad: {
                  description: "x",
                  input: z.object({}),
                  handler: async () => 1,
                  tags: "read-only" as unknown as string[],
                },
              },
            }),
          ],
        })
        .build(),
    ).rejects.toThrow(/tags/i);
  });
});

describe("testFn - exercise fn handlers in isolation", () => {
  /**
   * @case testFn validates input against the spec's schema before the handler runs
   * @preconditions Spec with z.object({ channel, text }); invoked with { channel: 123 }
   * @expectedResult RC5002 thrown; handler is never called
   */
  test("testFn rejects input that fails schema validation with RC5002", async () => {
    const handler = vi.fn(async () => "ok");
    await expect(
      testFn(
        {
          input: z.object({ channel: z.string(), text: z.string() }),
          handler,
        },
        { channel: 123, text: "x" },
      ),
    ).rejects.toMatchObject({ rc: "RC5002" });
    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * @case testFn calls the handler with validated input and a synthetic context
   * @preconditions Spec with z.object({ name: z.string() }); valid input
   * @expectedResult Handler receives validated input and a ctx with logger + abortSignal; return value flows out
   */
  test("testFn calls the handler with validated input and synthetic context", async () => {
    const handler = vi.fn(async (input: unknown, ctx) => {
      const typed = input as { name: string };
      expect(typed.name).toBe("alice");
      expect(ctx.logger).toBeDefined();
      expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
      return `hello ${typed.name}`;
    });
    const result = await testFn(
      { input: z.object({ name: z.string() }), handler },
      { name: "alice" },
    );
    expect(result).toBe("hello alice");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
   * @case testFn forwards a caller-supplied AbortSignal into the handler context
   * @preconditions testFn called with { signal: controller.signal }
   * @expectedResult Handler sees the exact signal instance
   */
  test("testFn forwards a caller-supplied abort signal", async () => {
    const controller = new AbortController();
    const handler = vi.fn(async (_input: unknown, ctx) => {
      expect(ctx.abortSignal).toBe(controller.signal);
      return "ok";
    });
    const result = await testFn(
      { input: z.object({}), handler },
      {},
      { signal: controller.signal },
    );
    expect(result).toBe("ok");
  });

  /**
   * @case testFn defaults to a never-firing AbortSignal when no signal is supplied
   * @preconditions testFn called without options
   * @expectedResult Handler sees a non-aborted AbortSignal
   */
  test("testFn provides a non-aborted default AbortSignal", async () => {
    const handler = vi.fn(async (_input: unknown, ctx) => {
      expect(ctx.abortSignal.aborted).toBe(false);
      return "ok";
    });
    await testFn({ input: z.object({}), handler }, {});
    expect(handler).toHaveBeenCalled();
  });

  /**
   * @case testFn passes a real FnOptions value structurally without complaint
   * @preconditions FnOptions value (extra `description` field present)
   * @expectedResult testFn ignores `description`, runs schema + handler, returns output
   */
  test("testFn accepts a real FnOptions value structurally", async () => {
    const fnSpec: FnOptions<{ q: string }, string> = {
      description: "Echoes",
      input: z.object({ q: z.string() }),
      handler: async (input) => input.q,
    };
    const result = await testFn(fnSpec, { q: "hi" });
    expect(result).toBe("hi");
  });

  /**
   * @case Schema coercion via .transform() is applied before the handler sees input
   * @preconditions Schema z.object({ n: z.string().transform(Number) })
   * @expectedResult Handler receives input.n as number; transform was applied
   */
  test("testFn applies Standard Schema coercion before the handler", async () => {
    const handler = vi.fn(async (input: unknown) => {
      const typed = input as { n: number };
      expect(typeof typed.n).toBe("number");
      expect(typed.n).toBe(42);
      return typed.n;
    });
    const result = await testFn(
      {
        input: z.object({ n: z.string().transform(Number) }),
        handler,
      },
      { n: "42" },
    );
    expect(result).toBe(42);
  });

  /**
   * @case Errors thrown by the handler propagate as-is
   * @preconditions Handler throws a plain Error
   * @expectedResult Original error bubbles out of testFn (no wrapping into RC code)
   */
  test("testFn lets handler errors propagate unchanged", async () => {
    const boom = new Error("boom");
    await expect(
      testFn(
        {
          input: z.object({}),
          handler: async () => {
            throw boom;
          },
        },
        {},
      ),
    ).rejects.toBe(boom);
  });

  /**
   * @case testFn errors carry the rc field for RC5002 (validation failures)
   * @preconditions Schema validation fails
   * @expectedResult Thrown error is a RoutecraftError with rc === "RC5002"
   */
  test("testFn validation errors are RoutecraftError instances", async () => {
    try {
      await testFn(
        { input: z.object({ n: z.number() }), handler: async () => 1 },
        { n: "not-a-number" },
      );
      throw new Error("testFn did not throw");
    } catch (err) {
      expect(isRoutecraftError(err)).toBe(true);
      expect((err as { rc?: string }).rc).toBe("RC5002");
    }
  });
});
