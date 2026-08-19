import { randomUUID } from "node:crypto";
import {
  rcError,
  type CraftContext,
  type Principal,
} from "@routecraft/routecraft";
import { isBlockLoaderTool } from "../block/resolve.ts";
import { toAiInputSchema } from "../llm/structured-output.ts";
import {
  makeFnHandlerContext,
  type FnSuspensionWiring,
} from "../fn/handler-context.ts";
import type { FnHandlerContext } from "../fn/types.ts";
import {
  anyAnswerSchema,
  isSuspendError,
  isSuspendSentinel,
} from "./suspend.ts";
import {
  SUSPENDED_TOOL_PLACEHOLDER,
  type AgentSuspendSignalRecord,
} from "./suspension-state.ts";
import type { AgentDispatchIdentity } from "./session.ts";
import type { ResolvedTool } from "./tools/selection.ts";

/**
 * The suspension channel between one agent dispatch and its tools: the
 * exchange identity `ctx.suspend` / `ctx.suspension` are wired from, and
 * the collector the bridge records raised signals into. The session reads
 * the collector after each model call; a non-empty batch stops the loop
 * and parks. Absent when the dispatch cannot park (no route-bound
 * exchange), which turns `ctx.suspend` into a typed AI1006 refusal.
 *
 * @internal
 */
export interface AgentSuspensionBridge {
  readonly wiring: FnSuspensionWiring;
  readonly signals: AgentSuspendSignalRecord[];
}

/**
 * Convert a list of `ResolvedTool` entries (the output of
 * `tools([...]).resolve(ctx)`) into a Vercel AI SDK tool map suitable
 * for `generateText({ tools })`.
 *
 * Each resulting tool runs:
 * 1. Emit `route:<routeId>:agent:tool:invoked` on the context bus so
 *    cross-cutting observability (telemetry, dashboards, audit) sees
 *    the call before the handler runs.
 * 2. The optional guard (registered via `tools([{ name, guard }])`).
 *    Throwing inside the guard surfaces back to the model as a tool
 *    error so the model can self-correct; the wrapper emits
 *    `agent:tool:error` before rethrowing.
 * 3. The underlying handler with `(input, fnHandlerContext)`. On
 *    success the wrapper emits `agent:tool:result`; on throw it
 *    emits `agent:tool:error` and rethrows.
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
  dispatchIdentity?: AgentDispatchIdentity,
  principal?: Principal,
  suspensions?: AgentSuspensionBridge,
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
      abortSignal,
      principal,
      suspensions?.wiring,
    );
    // Block-loader synthetic tools emit `agent:block:loaded` /
    // `agent:block:error` events instead of the user-tool family so
    // observability consumers can wire framework bookkeeping separately
    // from the agent's user-tool usage.
    const isLoader = isBlockLoaderTool(r);
    const blockName = isLoader
      ? ((r as { blockName?: string }).blockName ?? r.name)
      : undefined;
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
        // The Vercel SDK passes a unique toolCallId per invocation;
        // synthesise one when absent so invoked → result events still
        // correlate (a shared empty-string id would alias every call).
        const toolCallId = callOpts?.toolCallId ?? randomUUID();
        const start = Date.now();

        if (!isLoader && ctx && dispatchIdentity) {
          ctx.emit("route:agent:tool:invoked", {
            routeId: dispatchIdentity.routeId,
            exchangeId: dispatchIdentity.exchangeId,
            correlationId: dispatchIdentity.correlationId,
            toolCallId,
            toolName: r.name,
            // Sensitive payload: only persisted to telemetry when
            // snapshot capture is enabled (see telemetry `_snapshot`).
            _snapshot: { input },
          });
        }

        try {
          if (guard) await guard(input, callCtx);
          let output = await handler(input, callCtx);
          let suspended = false;
          if (isSuspendSentinel(output)) {
            // ctx.suspend already refuses (AI1006) when the bridge has no
            // suspension channel, so a sentinel arriving without one means
            // it was minted outside the handler context. Same refusal.
            if (!suspensions) {
              throw rcError("AI1006", undefined, {
                message: `Tool "${r.name}" returned a suspend sentinel, but this dispatch has no exchange to park. Durable suspension is only available inside an agent dispatch on a route-bound exchange.`,
              });
            }
            suspensions.signals.push({
              toolCallId,
              toolName: r.name,
              request: output.request,
            });
            // The recorded result is a neutral placeholder: the winner's is
            // replaced by the real answer at resume, a loser's is rewritten
            // to a retryable error before the park. The SDK still requires
            // every tool call to carry a result, which is why the bridge
            // answers instead of throwing.
            output = SUSPENDED_TOOL_PLACEHOLDER;
            suspended = true;
          }
          // A loader that suspends did NOT load its block: emitting
          // `block:loaded` with the placeholder snapshot would be the same
          // false receipt the MCP surface refuses, and it matches the
          // throw-form path below, which already stays silent for loaders.
          if (ctx && dispatchIdentity && !(suspended && isLoader)) {
            if (isLoader) {
              ctx.emit("route:agent:block:loaded", {
                routeId: dispatchIdentity.routeId,
                exchangeId: dispatchIdentity.exchangeId,
                correlationId: dispatchIdentity.correlationId,
                toolCallId,
                blockName: blockName!,
                // Sensitive payload: gated by snapshot capture.
                _snapshot: { output },
                duration: Date.now() - start,
              });
            } else {
              ctx.emit("route:agent:tool:result", {
                routeId: dispatchIdentity.routeId,
                exchangeId: dispatchIdentity.exchangeId,
                correlationId: dispatchIdentity.correlationId,
                toolCallId,
                toolName: r.name,
                // Sensitive payload: only persisted to telemetry when
                // snapshot capture is enabled (see telemetry `_snapshot`).
                _snapshot: { output },
                duration: Date.now() - start,
              });
            }
          }
          return output;
        } catch (err) {
          // The throw form of the suspend signal, honoured as an escape
          // hatch for handlers that cannot thread a return value out. Only
          // inside a parkable dispatch: elsewhere it stays an ordinary
          // error, which is the pre-durable behaviour.
          if (isSuspendError(err) && suspensions) {
            suspensions.signals.push({
              toolCallId,
              toolName: r.name,
              request: {
                expect: err.expect ?? anyAnswerSchema,
                ...(err.ttl !== undefined ? { ttl: err.ttl } : {}),
                ...(err.question !== undefined
                  ? { question: err.question }
                  : {}),
                ...(err.reason !== undefined ? { reason: err.reason } : {}),
              },
            });
            if (!isLoader && ctx && dispatchIdentity) {
              ctx.emit("route:agent:tool:result", {
                routeId: dispatchIdentity.routeId,
                exchangeId: dispatchIdentity.exchangeId,
                correlationId: dispatchIdentity.correlationId,
                toolCallId,
                toolName: r.name,
                _snapshot: { output: SUSPENDED_TOOL_PLACEHOLDER },
                duration: Date.now() - start,
              });
            }
            return SUSPENDED_TOOL_PLACEHOLDER;
          }
          if (ctx && dispatchIdentity) {
            if (isLoader) {
              ctx.emit("route:agent:block:error", {
                routeId: dispatchIdentity.routeId,
                exchangeId: dispatchIdentity.exchangeId,
                correlationId: dispatchIdentity.correlationId,
                toolCallId,
                blockName: blockName!,
                errorName: errorName(err),
                // Sensitive payload: error messages can echo the
                // rejected input, so the full error is gated by
                // snapshot capture like input/output.
                _snapshot: { error: err },
                duration: Date.now() - start,
              });
            } else {
              ctx.emit("route:agent:tool:error", {
                routeId: dispatchIdentity.routeId,
                exchangeId: dispatchIdentity.exchangeId,
                correlationId: dispatchIdentity.correlationId,
                toolCallId,
                toolName: r.name,
                errorName: errorName(err),
                // Sensitive payload: error messages can echo the
                // rejected input, so the full error is gated by
                // snapshot capture like input/output.
                _snapshot: { error: err },
                duration: Date.now() - start,
              });
            }
          }
          throw err;
        }
      },
    });
  }
  return out;
}

/**
 * Non-sensitive error classifier for tool/block error events. The error
 * message and stack may echo the rejected tool input, so they stay inside
 * the `_snapshot` envelope; the name alone (e.g. `TypeError`, `CraftError`)
 * is safe to persist unconditionally and is enough for dashboards to
 * distinguish failure classes.
 *
 * @internal
 */
function errorName(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}
