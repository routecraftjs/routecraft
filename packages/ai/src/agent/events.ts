import type { LlmUsage } from "../llm/types.ts";

/**
 * Discriminated union of events emitted by a streaming agent dispatch.
 * Forwarded to the user-supplied `AgentOptions.onEvent` listener while
 * the model + tool-calling loop runs. The set is a normalised subset of
 * the Vercel AI SDK's `streamText` full-stream parts; low-level parts
 * (text-start, text-end, tool-input-* deltas, abort) are filtered out
 * so the routecraft surface stays stable across SDK versions.
 *
 * @experimental
 */
export type AgentEvent =
  /** Incremental text from the model. Concatenate to render tokens live. */
  | { type: "text-delta"; text: string }
  /**
   * Incremental reasoning text from the provider (Anthropic extended
   * thinking, OpenAI o1). Useful for "thinking..." UI; safe to ignore.
   */
  | { type: "reasoning-delta"; text: string }
  /** Model decided to call a tool. `input` is the validated args. */
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  /** Tool handler returned successfully. `output` is the handler's return value. */
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: unknown;
    }
  /** Tool handler (or guard, or input validation) threw. */
  | {
      type: "tool-error";
      toolCallId: string;
      toolName: string;
      error: unknown;
    }
  /**
   * One step of the loop ended (a model call + any tool calls + their
   * results). Emitted before the next step begins, and once before
   * `finish` for the final step.
   */
  | {
      type: "step-finish";
      finishReason: string;
      usage?: LlmUsage;
    }
  /** The whole dispatch ended. Final consolidated result is returned by the destination. */
  | {
      type: "finish";
      finishReason: string;
      usage?: LlmUsage;
    }
  /** Provider or transport error surfaced through the stream. */
  | { type: "error"; error: unknown };

/**
 * Listener for streaming agent dispatches. Set on `AgentOptions.onEvent`
 * to receive events. Async listeners are awaited so back-pressure on a
 * slow consumer (e.g. an SSE channel) propagates into the stream.
 *
 * Throws inside the listener are caught and logged; they do not abort
 * the agent dispatch.
 *
 * @experimental
 */
export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

/**
 * Convert a Vercel AI SDK `streamText` full-stream part into an
 * `AgentEvent`. Returns `null` for parts that have no public-surface
 * equivalent (text-start/end markers, tool-input-* deltas, abort, raw
 * provider parts, etc.).
 *
 * @internal
 */
export function normalizeStreamPart(part: unknown): AgentEvent | null {
  if (part === null || typeof part !== "object") return null;
  const p = part as Record<string, unknown>;
  const type = p["type"];
  switch (type) {
    case "text-delta": {
      const text = readString(p, "text") ?? readString(p, "textDelta");
      if (text === undefined || text.length === 0) return null;
      return { type: "text-delta", text };
    }
    case "reasoning-delta": {
      const text = readString(p, "text") ?? readString(p, "delta");
      if (text === undefined || text.length === 0) return null;
      return { type: "reasoning-delta", text };
    }
    case "tool-call": {
      const toolCallId = readString(p, "toolCallId");
      const toolName = readString(p, "toolName");
      if (toolCallId === undefined || toolName === undefined) return null;
      const input = p["input"] ?? p["args"];
      return { type: "tool-call", toolCallId, toolName, input };
    }
    case "tool-result": {
      const toolCallId = readString(p, "toolCallId");
      const toolName = readString(p, "toolName");
      if (toolCallId === undefined || toolName === undefined) return null;
      const output = p["output"] ?? p["result"];
      return { type: "tool-result", toolCallId, toolName, output };
    }
    case "tool-error": {
      const toolCallId = readString(p, "toolCallId");
      const toolName = readString(p, "toolName");
      if (toolCallId === undefined || toolName === undefined) return null;
      return {
        type: "tool-error",
        toolCallId,
        toolName,
        error: p["error"],
      };
    }
    case "finish-step": {
      const finishReason = readString(p, "finishReason") ?? "unknown";
      const usage = readUsage(p["usage"]);
      return usage
        ? { type: "step-finish", finishReason, usage }
        : { type: "step-finish", finishReason };
    }
    case "finish": {
      const finishReason = readString(p, "finishReason") ?? "unknown";
      const usage = readUsage(p["totalUsage"]) ?? readUsage(p["usage"]);
      return usage
        ? { type: "finish", finishReason, usage }
        : { type: "finish", finishReason };
    }
    case "error": {
      return { type: "error", error: p["error"] };
    }
    default:
      return null;
  }
}

function readString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function readUsage(value: unknown): LlmUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  const out: LlmUsage = {};
  if (typeof u["inputTokens"] === "number") out.inputTokens = u["inputTokens"];
  if (typeof u["outputTokens"] === "number")
    out.outputTokens = u["outputTokens"];
  if (typeof u["totalTokens"] === "number") out.totalTokens = u["totalTokens"];
  return Object.keys(out).length > 0 ? out : undefined;
}
