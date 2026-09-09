/**
 * A stored transcript, rendered back as the updates that produced it.
 *
 * `session/load` is the reconnect path: an editor that lost its stream
 * makes a fresh one, initializes again, and loads the conversation. What
 * it gets is the same stream of updates it would have seen live, in
 * transcript order, before the response returns.
 *
 * The thread is the model's, in the SDK's message shape, so the mapping is
 * lossy on purpose: a tool call replays as completed with no timing and no
 * payload, because the record keeps what the model needs to continue and
 * not what a person watched happen.
 */

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ThreadMessage } from "../agent/deferral-state.ts";

/** Every update a stored transcript replays as, in order. */
export function replayUpdates(
  messages: readonly ThreadMessage[],
): SessionUpdate[] {
  const updates: SessionUpdate[] = [];
  for (const message of messages) {
    for (const part of partsOf(message)) {
      const update = replayPart(message.role, part);
      if (update !== undefined) updates.push(update);
    }
  }
  return updates;
}

/** One message's content parts, whatever shape the SDK stored it in. */
function partsOf(message: ThreadMessage): unknown[] {
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function replayPart(role: string, part: unknown): SessionUpdate | undefined {
  if (part === null || typeof part !== "object") return undefined;
  const p = part as Record<string, unknown>;
  const type = p["type"];

  if (type === "text" && typeof p["text"] === "string") {
    if (p["text"] === "") return undefined;
    return role === "user"
      ? {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: p["text"] },
        }
      : {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: p["text"] },
        };
  }

  if (type === "reasoning" && typeof p["text"] === "string") {
    return {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: p["text"] },
    };
  }

  if (type === "tool-call") {
    const toolCallId = p["toolCallId"];
    const toolName = p["toolName"];
    if (typeof toolCallId !== "string") return undefined;
    return {
      sessionUpdate: "tool_call",
      toolCallId,
      title: typeof toolName === "string" ? toolName : toolCallId,
      kind: "other",
      // Completed rather than in progress: a replayed call is one that
      // already ran, and a client that renders it as running would show a
      // spinner nothing will ever finish.
      status: "completed",
    };
  }

  return undefined;
}
