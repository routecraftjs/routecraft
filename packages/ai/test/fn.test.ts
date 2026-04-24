import { describe, test, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { ContextBuilder, rcError } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  ADAPTER_FN_REGISTRY,
  agentPlugin,
  invokeFn,
  type FnOptions,
} from "../src/index.ts";

describe("fn registration + invokeFn", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case agentPlugin registers a function in the context store keyed by id
   * @preconditions agentPlugin({ functions: { currentTime: {...} } })
   * @expectedResult ADAPTER_FN_REGISTRY store contains the registered entry
   */
  test("agentPlugin populates ADAPTER_FN_REGISTRY from the functions record", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              currentTime: {
                description: "Current UTC timestamp in ISO 8601",
                schema: z.object({}),
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
    expect(registry?.get("currentTime")?.description).toBe(
      "Current UTC timestamp in ISO 8601",
    );
  });

  /**
   * @case agentPlugin throws at init when a fn entry is missing its description
   * @preconditions functions entry without description
   * @expectedResult build() rejects with a message mentioning description
   */
  test("agentPlugin throws when a fn entry has no description", async () => {
    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            agentPlugin({
              functions: {
                broken: {
                  schema: z.object({}),
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
                  schema: z.object({}),
                  handler: async () => 1,
                },
              },
            }),
            agentPlugin({
              functions: {
                dup: {
                  description: "second",
                  schema: z.object({}),
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
   * @case invokeFn validates input against the fn's schema before the handler runs
   * @preconditions fn with schema z.object({ channel: z.string() }); invoked with { channel: 123 }
   * @expectedResult RC5002 thrown; handler is not called
   */
  test("invokeFn rejects input that fails schema validation with RC5002", async () => {
    const handler = vi.fn(async () => "ok");
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              sendSlackMessage: {
                description: "Post a message to Slack",
                schema: z.object({ channel: z.string(), text: z.string() }),
                handler,
              },
            },
          }),
        ],
      })
      .build();

    await expect(
      invokeFn(t.ctx, "sendSlackMessage", {
        channel: 123 as unknown as string,
        text: "x",
      }),
    ).rejects.toMatchObject({ rc: "RC5002" });
    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * @case invokeFn throws RC5004 when the fn id is not registered
   * @preconditions agentPlugin installed but "unknown" is not registered
   * @expectedResult invokeFn rejects with RC5004 and lists known ids in the message
   */
  test("invokeFn throws RC5004 for an unknown id", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              known: {
                description: "Known fn",
                schema: z.object({}),
                handler: async () => "ok",
              },
            },
          }),
        ],
      })
      .build();

    await expect(invokeFn(t.ctx, "unknown", {})).rejects.toMatchObject({
      rc: "RC5004",
    });
  });

  /**
   * @case invokeFn throws RC5004 when no fn registry is present in the context
   * @preconditions No agentPlugin installed
   * @expectedResult invokeFn rejects with RC5004 and points the user to agentPlugin
   */
  test("invokeFn throws RC5004 when the fn registry is missing from the context", async () => {
    t = await testContext().build();
    await expect(invokeFn(t.ctx, "anything", {})).rejects.toMatchObject({
      rc: "RC5004",
    });
  });

  /**
   * @case invokeFn passes validated input and a handler context to the handler and returns its output
   * @preconditions Registered fn with schema, z-coerced input, async handler returning a value
   * @expectedResult Handler called with validated input and a ctx containing logger + abortSignal + context; return value flows out of invokeFn
   */
  test("invokeFn calls the handler with validated input and handler context", async () => {
    const handler = vi.fn();
    handler.mockImplementation(async (input: unknown, ctx) => {
      const typed = input as { name: string };
      expect(typed.name).toBe("alice");
      expect(ctx.logger).toBeDefined();
      expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
      expect(ctx.context).toBeDefined();
      return `hello ${typed.name}`;
    });

    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              greet: {
                description: "Greets someone",
                schema: z.object({ name: z.string() }),
                handler,
              },
            },
          }),
        ],
      })
      .build();

    const result = await invokeFn<{ name: string }, string>(t.ctx, "greet", {
      name: "alice",
    });
    expect(result).toBe("hello alice");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
   * @case invokeFn forwards the caller-supplied AbortSignal into FnHandlerContext.abortSignal
   * @preconditions invokeFn called with { signal: myController.signal }
   * @expectedResult Handler sees the exact signal instance; aborting it is observable inside the handler
   */
  test("invokeFn forwards a caller-supplied abort signal", async () => {
    const controller = new AbortController();
    const handler = vi.fn(async (_input, ctx) => {
      expect(ctx.abortSignal).toBe(controller.signal);
      return "ok";
    });

    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              probe: {
                description: "Probes the signal",
                schema: z.object({}),
                handler,
              },
            },
          }),
        ],
      })
      .build();

    const result = await invokeFn(
      t.ctx,
      "probe",
      {},
      {
        signal: controller.signal,
      },
    );
    expect(result).toBe("ok");
  });

  /**
   * @case rcError is exported from @routecraft/routecraft and invokeFn errors carry the rc field
   * @preconditions invokeFn with an unregistered id
   * @expectedResult The thrown RoutecraftError has .rc === "RC5004"
   */
  test("invokeFn errors are RoutecraftError instances with rc set", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: {
              known: {
                description: "Known fn",
                schema: z.object({}),
                handler: async () => 1,
              },
            },
          }),
        ],
      })
      .build();

    try {
      await invokeFn(t.ctx, "unknown", {});
      throw new Error("invokeFn did not throw");
    } catch (err) {
      const expected = rcError("RC5004", undefined, { message: "x" });
      expect((err as { rc?: string }).rc).toBe(expected.rc);
    }
  });
});
