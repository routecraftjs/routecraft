import type { LlmPromptPart } from "../../llm/types.ts";
import type { ThreadMessage } from "../suspension-state.ts";

/** The shape version {@link AgentSessionRecord} is written at. */
export const SESSION_RECORD_VERSION = 1;

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
      /**
       * The subject of the principal that posted it, or `null` for an
       * exchange that carried none, so a subject that reads "anonymous" is
       * still a subject. A
       * queued message is consumed under whichever turn runs next, so the
       * attribution travels with the message and is rendered to the model
       * as data: the transcript and the model both see who said it.
       */
      readonly by: string | null;
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
      /** The subject of the principal whose turn started the call, or `null`. */
      readonly by: string | null;
    };

/** A background tool call the session is still waiting on. */
export interface AgentBackgroundCall {
  readonly handle: string;
  readonly tool: string;
  readonly startedAt: string;
  /** The subject of the principal whose turn started it, or `null`. */
  readonly by: string | null;
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
  /**
   * The record's shape version, checked on every read so a record written
   * by another release of this package fails as `AI1010` naming the store
   * rather than as a provider refusing a message part one turn later.
   */
  readonly version: typeof SESSION_RECORD_VERSION;
  readonly agent: string;
  readonly session: string;
  /**
   * The subject of the principal whose turn started the session, or
   * `null` when no principal did; who owns the conversation, for an operator. Never a
   * gate: who may post is the route's `.authorize()`.
   */
  readonly startedBy?: string | null;
  /** The transcript, in the SDK's message shape. */
  readonly messages: readonly ThreadMessage[];
  readonly inbox: readonly AgentInboxMessage[];
  readonly turn?: { readonly exchangeId: string; readonly startedAt: string };
  readonly background: readonly AgentBackgroundCall[];
  /**
   * The stored continuation of the exchange whose turn ended with work
   * outstanding, revived to run the next turn when a background call
   * settles, when messages are queued, or at boot. One per session: a
   * later turn that ends with work outstanding keeps the one that exists.
   */
  readonly park?: AgentSessionPark;
  /**
   * The continuation about to be stored, named before the park exists and
   * cleared once `park` names it. A crash between those two writes leaves
   * this set with `park` unset, which is how the next boot finds an aside
   * park nothing else references and releases it; an aside park carries no
   * expiry, so nothing else would.
   */
  readonly parking?: AgentSessionPark;
  /** Completed turns. */
  readonly turns: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Where a session's stored continuation is. */
export interface AgentSessionPark {
  readonly suspensionId: string;
  readonly routeId: string;
}

/**
 * What a session park stores as its step state, so the revived step knows
 * it re-enters as a turn and not as a parked tool loop. The transcript and
 * the inbox stay in the session record; this names them, it does not
 * carry them.
 *
 * @internal
 */
export interface AgentSessionParkMarker {
  readonly kind: "agent-session-park";
  readonly agent: string;
  readonly session: string;
  readonly suspensionId: string;
}

/** @internal */
export function isSessionParkMarker(
  value: unknown,
): value is AgentSessionParkMarker {
  const marker = value as Partial<AgentSessionParkMarker> | null | undefined;
  return (
    marker !== null &&
    typeof marker === "object" &&
    marker.kind === "agent-session-park" &&
    typeof marker.agent === "string" &&
    typeof marker.session === "string" &&
    typeof marker.suspensionId === "string"
  );
}

/**
 * How a dispatch with `session` set was handled, on `AgentResult.session`.
 *
 * - `replied`: this call's message started a turn and `text` is its reply.
 * - `queued`: a turn was already running, so the message went to the inbox
 *   and is answered by the turn that consumes it; `text` is empty.
 * - `interrupted`: this call's turn was interrupted by a later message. The
 *   partial transcript is stored and `text` is empty.
 * - `idle`: a revived continuation found nothing to run, because another
 *   turn had consumed the inbox first; `text` is empty and no model call
 *   was made. Only a revived exchange can carry it.
 */
export interface AgentSessionOutcome {
  readonly agent: string;
  readonly id: string;
  readonly status: "replied" | "queued" | "interrupted" | "idle";
  /** Inbox depth after this message was handled. */
  readonly queued: number;
}

/** A session as the management API lists it. */
export interface AgentSessionSummary {
  readonly agent: string;
  readonly session: string;
  /** The subject that started the session, or `null` when no principal did. */
  readonly startedBy: string | null;
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
  /** A continuation is stored, waiting for a completion or a boot to revive it. */
  readonly parked: boolean;
  /** Transcript length, in messages. */
  readonly messages: number;
  readonly turns: number;
  readonly updatedAt: string;
}
