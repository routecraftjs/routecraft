import type { LlmPromptPart } from "../../llm/types.ts";
import type { ThreadMessage } from "../suspension-state.ts";

/** What names a conversation: the agent it belongs to and the caller's id. */
export interface AgentSessionKey {
  readonly agent: string;
  readonly session: string;
}

/**
 * One entry waiting in a session's inbox, delivered at the next turn
 * boundary in arrival order.
 *
 * A `message` is what a caller posted while a turn was running. A
 * `background` entry is what a background tool posted when its route
 * finished: the result, or the failure, attributed to the handle the tool
 * returned so the model can match it to the call it made.
 */
export type AgentInboxMessage =
  | {
      readonly kind: "message";
      /** Correlates the entry with the caller waiting on it. */
      readonly id: string;
      readonly content: string | LlmPromptPart[];
      readonly at: string;
      /** The message asked for the running turn to be interrupted. */
      readonly interrupt?: boolean;
    }
  | {
      readonly kind: "background";
      readonly id: string;
      readonly handle: string;
      readonly tool: string;
      readonly status: "completed" | "failed";
      readonly result?: unknown;
      readonly error?: { readonly rc?: string; readonly message: string };
      readonly at: string;
    };

/** A background tool call the session is still waiting on. */
export interface AgentBackgroundCall {
  readonly handle: string;
  readonly tool: string;
  readonly startedAt: string;
}

/**
 * What the store holds for one session, in the suspension record's opaque
 * `stepState` slot. Plain JSON only: dates are ISO strings and every field
 * survives `encodePersistable`.
 *
 * `turn` is set while a turn is running and cleared at its boundary. A
 * record loaded with `turn` set by a process that is no longer running is
 * a turn a restart cut short: its transcript is kept, its inbox is intact,
 * and the next turn treats it as interrupted.
 */
export interface AgentSessionRecord {
  readonly kind: "agent-session";
  readonly agent: string;
  readonly session: string;
  /** The transcript, in the SDK's message shape. */
  readonly messages: readonly ThreadMessage[];
  readonly inbox: readonly AgentInboxMessage[];
  readonly turn?: { readonly exchangeId: string; readonly startedAt: string };
  readonly background: readonly AgentBackgroundCall[];
  /** Completed turns. */
  readonly turns: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * How a dispatch with `session` set was handled, on `AgentResult.session`.
 *
 * - `replied`: this call's message started a turn and `text` is its reply.
 * - `queued`: a turn was already running, so the message went to the inbox
 *   and is answered by the turn that consumes it; `text` is empty.
 * - `interrupted`: this call's turn was interrupted by a later message. The
 *   partial transcript is stored and `text` is empty.
 */
export interface AgentSessionOutcome {
  readonly agent: string;
  readonly id: string;
  readonly status: "replied" | "queued" | "interrupted";
  /** Inbox depth after this message was handled. */
  readonly queued: number;
}

/** A session as the management API lists it. */
export interface AgentSessionSummary {
  readonly agent: string;
  readonly session: string;
  /**
   * `running` while this process runs a turn; `stale` when the stored
   * turn marker belongs to a process that is gone, which the next turn
   * treats as an interrupt; `idle` otherwise.
   */
  readonly turn: "idle" | "running" | "stale";
  /** Messages waiting for the next turn boundary. */
  readonly inbox: number;
  /** Background tool calls still running. */
  readonly background: number;
  /** Transcript length, in messages. */
  readonly messages: number;
  readonly turns: number;
  readonly updatedAt: string;
}
