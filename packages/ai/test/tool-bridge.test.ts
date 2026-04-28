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
   * @case Principal from the dispatching exchange surfaces on the tool ctx
   * @preconditions buildVercelTools called with a Principal; handler captures its ctx
   * @expectedResult Handler's ctx.principal matches the supplied Principal (not undefined)
   */
  test("principal flows through to the handler ctx", async () => {
    const handler = vi.fn(async () => "done");
    const resolved: ResolvedTool = {
      name: "needs-auth",
      description: "Needs auth.",
      input: z.object({}),
      handler: handler as ResolvedTool["handler"],
    };
    const principal = {
      kind: "jwt" as const,
      scheme: "bearer" as const,
      subject: "user-42",
      scopes: ["read", "write"],
    };
    const map = await buildVercelTools(
      [resolved],
      undefined,
      new AbortController().signal,
      undefined,
      principal,
    );
    const tool = map["needs-auth"] as {
      execute: (input: unknown) => Promise<unknown>;
    };
    await tool.execute({});
    const callArgs = handler.mock.calls[0] as unknown as [
      input: unknown,
      ctx: { principal?: typeof principal },
    ];
    expect(callArgs[1].principal).toEqual(principal);
  });

  /**
   * @case Tool handler cannot mutate the principal snapshot at runtime
   * @preconditions Principal supplied to buildVercelTools; handler attempts to push to scopes and replace claims
   * @expectedResult Both attempts throw a TypeError (frozen object); the handler's ctx.principal !== the original (it's a snapshot clone) so freezing does not pollute the caller's reference
   */
  test("principal snapshot is deep-frozen and isolated from the caller", async () => {
    let capturedCtx:
      | { principal?: { scopes?: readonly string[]; claims?: object } }
      | undefined;
    const handler = vi.fn(async (_input: unknown, ctx: unknown) => {
      capturedCtx = ctx as {
        principal?: { scopes?: readonly string[]; claims?: object };
      };
    });
    const resolved: ResolvedTool = {
      name: "snapshot-check",
      description: "Snapshot check.",
      input: z.object({}),
      handler: handler as unknown as ResolvedTool["handler"],
    };
    const principal = {
      kind: "jwt" as const,
      scheme: "bearer" as const,
      subject: "user-42",
      scopes: ["read"],
      claims: { tenantId: "abc" },
    };
    const map = await buildVercelTools(
      [resolved],
      undefined,
      new AbortController().signal,
      undefined,
      principal,
    );
    const tool = map["snapshot-check"] as {
      execute: (input: unknown) => Promise<unknown>;
    };
    await tool.execute({});

    const snapshot = capturedCtx!.principal!;
    // The exposed snapshot is a clone, not the caller's original object.
    expect(snapshot).not.toBe(principal);
    // Mutating the original after the fact must not affect the snapshot.
    principal.scopes.push("write");
    expect(snapshot.scopes).toEqual(["read"]);
    // Runtime: a tool that bypasses the readonly type still cannot mutate.
    expect(() => {
      (snapshot.scopes as string[]).push("admin");
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.claims as Record<string, unknown>)["tenantId"] = "evil";
    }).toThrow(TypeError);
    expect(() => {
      (snapshot as { subject?: string }).subject = "impersonated";
    }).toThrow(TypeError);
  });

  /**
   * @case Nested claim objects are deep-cloned and deep-frozen
   * @preconditions Principal with a nested object claim and a nested array claim
   * @expectedResult Mutating the original nested objects does not affect the snapshot; runtime mutation of nested values throws TypeError
   */
  test("nested claim objects are deep-frozen and isolated", async () => {
    let capturedCtx: { principal?: { claims?: Record<string, unknown> } } = {};
    const handler = vi.fn(async (_input: unknown, ctx: unknown) => {
      capturedCtx = ctx as {
        principal?: { claims?: Record<string, unknown> };
      };
    });
    const resolved: ResolvedTool = {
      name: "nested-claims",
      description: "Nested claims.",
      input: z.object({}),
      handler: handler as unknown as ResolvedTool["handler"],
    };
    const principal = {
      kind: "jwt" as const,
      scheme: "bearer" as const,
      subject: "user-42",
      claims: {
        perms: { write: false, admin: false },
        tags: ["alpha", "beta"],
      },
    };
    const map = await buildVercelTools(
      [resolved],
      undefined,
      new AbortController().signal,
      undefined,
      principal,
    );
    const tool = map["nested-claims"] as {
      execute: (input: unknown) => Promise<unknown>;
    };
    await tool.execute({});

    const claims = capturedCtx.principal!.claims as {
      perms: { write: boolean; admin: boolean };
      tags: string[];
    };
    // Snapshot is a deep clone: mutating the original nested perms / tags
    // after dispatch must not leak into the snapshot.
    principal.claims.perms.admin = true;
    principal.claims.tags.push("gamma");
    expect(claims.perms).toEqual({ write: false, admin: false });
    expect(claims.tags).toEqual(["alpha", "beta"]);
    // Runtime: a tool that bypasses the readonly type still cannot
    // mutate any nested claim value or array.
    expect(() => {
      claims.perms.admin = true;
    }).toThrow(TypeError);
    expect(() => {
      claims.tags.push("evil");
    }).toThrow(TypeError);
  });

  /**
   * @case TypedArray (Buffer / Uint8Array) inside claims does not crash dispatch
   * @preconditions Principal with `claims.binary = Uint8Array(...)`
   * @expectedResult buildVercelTools + execute succeed; the binary value reaches the handler intact
   */
  test("binary claim values do not crash deep-freeze", async () => {
    let captured: { binary?: Uint8Array } | undefined;
    const handler = vi.fn(async (_input: unknown, ctx: unknown) => {
      const c = ctx as {
        principal?: { claims?: { binary?: Uint8Array } };
      };
      captured = c.principal?.claims;
    });
    const resolved: ResolvedTool = {
      name: "binary-claim",
      description: "Binary claim.",
      input: z.object({}),
      handler: handler as unknown as ResolvedTool["handler"],
    };
    const principal = {
      kind: "jwt" as const,
      scheme: "bearer" as const,
      subject: "user-42",
      claims: { binary: new Uint8Array([1, 2, 3]) },
    };
    const map = await buildVercelTools(
      [resolved],
      undefined,
      new AbortController().signal,
      undefined,
      principal,
    );
    const tool = map["binary-claim"] as {
      execute: (input: unknown) => Promise<unknown>;
    };
    await expect(tool.execute({})).resolves.toBeUndefined();
    expect(Array.from(captured!.binary!)).toEqual([1, 2, 3]);
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
