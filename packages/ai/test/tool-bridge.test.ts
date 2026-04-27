import { describe, test, expect, vi } from "vitest";
import { z } from "zod";
import { buildVercelTools } from "../src/agent/tool-bridge.ts";
import type { ResolvedTool } from "../src/agent/tools/selection.ts";

describe("buildVercelTools: execute path", () => {
  /**
   * @case Empty input returns empty record
   * @preconditions buildVercelTools([], undefined, signal)
   * @expectedResult Returned object has no keys
   */
  test("empty resolved tools returns an empty map", async () => {
    const out = await buildVercelTools(
      [],
      undefined,
      new AbortController().signal,
    );
    expect(Object.keys(out)).toEqual([]);
  });

  /**
   * @case Single resolved tool produces one Vercel tool keyed by name; per-call options merge into the handler context
   * @preconditions Resolved tool; execute called with the SDK's `(input, options)` signature carrying a per-call abortSignal
   * @expectedResult Returned map has key "echo"; handler receives the input as the first arg and a context whose abortSignal is the per-call one (not the construction-time signal)
   */
  test("single resolved tool builds a Vercel tool that runs the handler", async () => {
    const handler = vi.fn(
      async (input: unknown) => `echoed ${(input as { msg: string }).msg}`,
    );
    const resolved: ResolvedTool = {
      name: "echo",
      description: "Echoes the input.",
      input: z.object({ msg: z.string() }),
      handler: handler as ResolvedTool["handler"],
    };

    const sessionSignal = new AbortController().signal;
    const map = await buildVercelTools([resolved], undefined, sessionSignal);
    expect(Object.keys(map)).toEqual(["echo"]);

    // Exercise the SDK's (input, options) contract; the second arg
    // carries a per-call abortSignal which must override the
    // session-wide one captured at buildVercelTools time.
    const perCallSignal = new AbortController().signal;
    const tool = map["echo"] as {
      execute: (
        input: unknown,
        opts?: {
          abortSignal?: AbortSignal;
          toolCallId?: string;
          messages?: unknown[];
        },
      ) => Promise<unknown>;
    };
    const result = await tool.execute(
      { msg: "hi" },
      { toolCallId: "call-1", messages: [], abortSignal: perCallSignal },
    );
    expect(result).toBe("echoed hi");
    expect(handler).toHaveBeenCalledTimes(1);
    const callArgs = handler.mock.calls[0] as unknown as [
      input: unknown,
      ctx: { abortSignal: AbortSignal },
    ];
    expect(callArgs[0]).toEqual({ msg: "hi" });
    expect(callArgs[1].abortSignal).toBe(perCallSignal);
    expect(callArgs[1].abortSignal).not.toBe(sessionSignal);
  });

  /**
   * @case Guard runs before handler and can short-circuit by throwing
   * @preconditions Resolved tool with a guard that throws
   * @expectedResult execute() rejects with the guard's error; handler is never called
   */
  test("guard throwing prevents the handler from running", async () => {
    const handler = vi.fn();
    const guard = vi.fn(async () => {
      throw new Error("denied");
    });
    const resolved: ResolvedTool = {
      name: "guarded",
      description: "Has a guard.",
      input: z.object({}),
      guard: guard as NonNullable<ResolvedTool["guard"]>,
      handler: handler as ResolvedTool["handler"],
    };

    const map = await buildVercelTools(
      [resolved],
      undefined,
      new AbortController().signal,
    );
    const tool = map["guarded"] as {
      execute: (input: unknown) => Promise<unknown>;
    };
    await expect(tool.execute({})).rejects.toThrow(/denied/);
    expect(handler).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledTimes(1);
  });

  /**
   * @case Guard that resolves passes through to the handler
   * @preconditions Guard returns void (no throw)
   * @expectedResult Handler runs and returns its value
   */
  test("guard resolving lets the handler run", async () => {
    const handler = vi.fn(async () => "ok");
    const guard = vi.fn(async () => undefined);
    const resolved: ResolvedTool = {
      name: "ok-guard",
      description: "Guard then run.",
      input: z.object({}),
      guard: guard as NonNullable<ResolvedTool["guard"]>,
      handler: handler as ResolvedTool["handler"],
    };
    const map = await buildVercelTools(
      [resolved],
      undefined,
      new AbortController().signal,
    );
    const tool = map["ok-guard"] as {
      execute: (input: unknown) => Promise<unknown>;
    };
    const result = await tool.execute({});
    expect(result).toBe("ok");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
