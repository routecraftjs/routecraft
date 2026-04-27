/**
 * Token-level delta emitted while a streaming agent dispatch writes
 * its response. Forwarded to the user-supplied `AgentOptions.onDelta`
 * listener as the model emits tokens.
 *
 * `AgentDelta` is INTENTIONALLY narrow: it covers only token-level
 * incremental updates that need a directed, back-pressure-aware
 * delivery channel (the canonical case is forwarding to a single
 * SSE / WebSocket / TUI consumer). Coarse decision events (tool-call,
 * tool-result, step-finished, finished) live on the context bus
 * (`route:<id>:agent:*`) where they're broadcast to every subscriber
 * without per-call wiring.
 *
 * @experimental
 */
export type AgentDelta =
  /** Incremental text from the model. Concatenate to render tokens live. */
  | { type: "text-delta"; text: string }
  /**
   * Incremental reasoning text from the provider (Anthropic extended
   * thinking, OpenAI o1). Useful for "thinking..." UI; safe to ignore.
   */
  | { type: "reasoning-delta"; text: string };

/**
 * Listener for streaming agent dispatches. Set on
 * `AgentOptions.onDelta` to receive token-level deltas. Async
 * listeners are awaited so back-pressure on a slow consumer (e.g. an
 * SSE channel) propagates into the stream.
 *
 * Throws inside the listener are caught and logged; they do not abort
 * the agent dispatch.
 *
 * @experimental
 */
export type AgentDeltaListener = (delta: AgentDelta) => void | Promise<void>;

/**
 * Convert a Vercel AI SDK `streamText` full-stream part into an
 * `AgentDelta`. Returns `null` for parts that have no public-surface
 * equivalent on the delta channel (text-start/end markers,
 * tool-input-* deltas, abort, raw provider parts, AND tool-call /
 * tool-result / finish-step / finish / error parts that now flow
 * through the context bus instead).
 *
 * @internal
 */
export function normalizeStreamDelta(part: unknown): AgentDelta | null {
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
