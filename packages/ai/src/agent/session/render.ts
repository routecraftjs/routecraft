import type { LlmPromptPart } from "../../llm/types.ts";
import { INTERRUPTED_TOOL_MESSAGE } from "../run.ts";
import { contentPartsOf, type ThreadMessage } from "../suspension-state.ts";
import type { AgentInboxMessage, AgentSessionKey } from "./types.ts";

/**
 * The system block that tells the model which conversation it is in.
 * Appended last, after the author's prompt, blocks and the caller section,
 * so the request-scoped facts sit closest to the user turn.
 *
 * @internal
 */
export function sessionSystemBlock(key: AgentSessionKey): string {
  return (
    "## Session\n\n" +
    `This conversation is session "${oneLine(key.session)}" of agent "${oneLine(key.agent)}". ` +
    "Pass this session id to any tool that takes one. " +
    "Messages sent while a turn was running are delivered together at the start of the next turn, as separate parts of one user message. " +
    "A tool that runs in the background returns a handle immediately; its result arrives the same way, in a later message naming that handle."
  );
}

/**
 * Fold the inbox and the incoming message into the one user message the
 * next turn starts with. A lone string message stays a string, which is
 * what a sessionless turn sends; anything else becomes content parts in
 * arrival order, so the model sees the queued messages together and in
 * sequence.
 *
 * @internal
 */
export function renderUserMessage(
  inbox: readonly AgentInboxMessage[],
  incoming: string | LlmPromptPart[] | undefined,
): ThreadMessage {
  if (inbox.length === 0 && typeof incoming === "string") {
    return { role: "user", content: incoming };
  }
  const parts: LlmPromptPart[] = [];
  for (const entry of inbox) parts.push(...partsOf(entry));
  if (incoming !== undefined) {
    if (typeof incoming === "string")
      parts.push({ type: "text", text: incoming });
    else parts.push(...incoming);
  }
  return { role: "user", content: parts };
}

function partsOf(entry: AgentInboxMessage): LlmPromptPart[] {
  if (entry.kind === "message") {
    return typeof entry.content === "string"
      ? [{ type: "text", text: entry.content }]
      : entry.content;
  }
  const heading =
    entry.status === "completed"
      ? `[Background tool "${entry.tool}" finished. Handle: ${entry.handle}]`
      : `[Background tool "${entry.tool}" failed. Handle: ${entry.handle}]`;
  const body =
    entry.status === "completed"
      ? describe(entry.result)
      : `${entry.error?.rc !== undefined ? `${entry.error.rc}: ` : ""}${entry.error?.message ?? "unknown error"}`;
  return [{ type: "text", text: `${heading}\n${body}` }];
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Close every tool call in a thread that has no result, with the same
 * "interrupted" error result an in-process interrupt records. A turn cut
 * short by a restart persisted its last finished step and nothing after
 * it, but a thread that ends on an assistant message with tool calls and
 * no tool message is refused by every provider, so the next turn could
 * never start from it.
 *
 * @internal
 */
export function closeUnansweredToolCalls(
  messages: readonly ThreadMessage[],
): ThreadMessage[] {
  const answered = new Set<string>();
  for (const message of messages) {
    for (const part of contentPartsOf(message, "tool") ?? []) {
      const id = (part as { toolCallId?: unknown } | null)?.toolCallId;
      if (typeof id === "string") answered.add(id);
    }
  }
  const open: Array<{ toolCallId: string; toolName: string }> = [];
  for (const message of messages) {
    for (const part of contentPartsOf(message, "assistant") ?? []) {
      const p = part as {
        type?: unknown;
        toolCallId?: unknown;
        toolName?: unknown;
      } | null;
      if (p?.type !== "tool-call" || typeof p.toolCallId !== "string") continue;
      if (answered.has(p.toolCallId)) continue;
      open.push({
        toolCallId: p.toolCallId,
        toolName: typeof p.toolName === "string" ? p.toolName : "unknown",
      });
    }
  }
  if (open.length === 0) return [...messages];
  return [
    ...messages,
    {
      role: "tool",
      content: open.map((call) => ({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "error-text", value: INTERRUPTED_TOOL_MESSAGE },
      })),
    },
  ];
}

function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}
