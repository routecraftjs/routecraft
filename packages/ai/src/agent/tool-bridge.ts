import {
  logger as frameworkLogger,
  type CraftContext,
} from "@routecraft/routecraft";
import { toAiInputSchema } from "../llm/structured-output.ts";
import type { FnHandlerContext } from "../fn/types.ts";
import type { ResolvedTool } from "./tools/selection.ts";

/**
 * Convert a list of `ResolvedTool` entries (the output of
 * `tools([...]).resolve(ctx)`) into a Vercel AI SDK tool map suitable
 * for `generateText({ tools })`.
 *
 * Each resulting tool runs:
 * 1. The optional guard (registered via `tools([{ name, guard }])` or
 *    `tools([{ tagged, guard }])`). Throwing inside the guard surfaces
 *    back to the model as a tool error so the model can self-correct.
 * 2. The underlying handler with `(input, fnHandlerContext)`.
 *
 * Schema validation is delegated to the SDK: when the model's tool-call
 * args fail to match `inputSchema`, the SDK reports a tool error to
 * the model without calling `execute`. Successful validation passes
 * the parsed value through to `execute`.
 *
 * @internal
 */
export async function buildVercelTools(
  resolved: ResolvedTool[],
  ctx: CraftContext | undefined,
  abortSignal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (resolved.length === 0)
    return Object.create(null) as Record<string, unknown>;
  const { tool } = await import("ai");

  // Use a null-prototype object so dynamic tool names supplied at
  // resolution time can never mutate Object.prototype (e.g. a tool
  // accidentally named "__proto__" would otherwise be a vector for
  // prototype pollution).
  const out: Record<string, unknown> = Object.create(null);
  for (const r of resolved) {
    const guard = r.guard;
    const handler = r.handler;
    const baseCtx: FnHandlerContext = makeFnHandlerContext(
      r.name,
      ctx,
      abortSignal,
    );
    out[r.name] = tool({
      description: r.description,
      inputSchema: toAiInputSchema(r.input) as Parameters<
        typeof tool
      >[0]["inputSchema"],
      execute: async (
        input: unknown,
        callOpts?: {
          abortSignal?: AbortSignal;
          toolCallId?: string;
          messages?: unknown[];
        },
      ) => {
        // Merge per-call options (the SDK passes its own abortSignal
        // and toolCallId per invocation) into the handler context so
        // a tool can react to per-step cancellation, not just the
        // session-wide signal captured at buildVercelTools time.
        const callCtx: FnHandlerContext = {
          ...baseCtx,
          abortSignal: callOpts?.abortSignal ?? baseCtx.abortSignal,
        };
        if (guard) await guard(input, callCtx);
        return await handler(input, callCtx);
      },
    });
  }
  return out;
}

/**
 * Construct the synthetic `FnHandlerContext` handed to a tool's guard
 * and handler during agent dispatch. Mirrors the shape `testFn`
 * provides: `logger`, `abortSignal`, optional `context`,
 * optional `correlationId` (not yet populated by the runtime), and
 * optional `checkpointId` (durable-agents epic).
 */
function makeFnHandlerContext(
  toolName: string,
  ctx: CraftContext | undefined,
  abortSignal: AbortSignal,
): FnHandlerContext {
  return {
    logger: frameworkLogger.child({ tool: toolName }),
    abortSignal,
    ...(ctx ? { context: ctx } : {}),
  };
}
