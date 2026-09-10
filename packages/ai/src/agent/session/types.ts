import type {
  LlmModelId,
  LlmPromptPart,
  LlmReasoningEffort,
} from "../../llm/types.ts";
import type { ThreadMessage } from "../deferral-state.ts";

/**
 * The shape version {@link AgentSessionRecord} is written at.
 *
 * Version 2 replaced `startedBy` with {@link AgentSessionRecord.owner} and
 * added `cwd`, `title` and `overrides`. Version 3 renamed the two
 * continuation fields to {@link AgentSessionRecord.deferral} and
 * {@link AgentSessionRecord.deferring} and the marker kind with them.
 *
 * The bump is load-bearing rather than cosmetic. Both fields are optional, so
 * a version 2 record would pass the shape guard with its continuation read as
 * absent, and an aside deferral nothing references carries no expiry: it would
 * never be revived and never released. There is no migration and no shim: an
 * older record fails its read as `AI1010` naming the store, which is what the
 * version field exists for.
 */
export const SESSION_RECORD_VERSION = 3;

/**
 * Per-session choices a caller made about how the agent runs, applied over
 * the agent's registered options at the start of every turn.
 *
 * Validated against the agent's advertised lists before the record is
 * written (`AI1017`), so a stored override can never name a model or a
 * thinking level the agent does not offer.
 */
export interface AgentSessionOverrides {
  readonly model?: LlmModelId;
  readonly reasoning?: LlmReasoningEffort;
}

/**
 * Who a conversation is listed and read for.
 *
 * `{ owner }` is one caller's view: the listing carries their sessions and
 * nothing else, and a session owned by somebody else answers exactly as one
 * that does not exist. `"operator"` is the whole store, and it is a
 * deliberate privilege rather than the absence of a filter, which is why
 * every read names its scope rather than defaulting to one.
 */
export type AgentSessionScope = { readonly owner: string | null } | "operator";

/**
 * What names a conversation: its id, and nothing else.
 *
 * The agent is an attribute of a session rather than part of its identity,
 * so an id issued today carries no assumption about which agent answers
 * it. Which one does is fixed when the session is created and cannot
 * change afterwards: {@link AgentSessionRuntime} refuses a dispatch whose
 * agent differs from the record's, and offers no way to set it. The
 * framework
 * already draws identity this way: an exchange is a UUID that the caller
 * may override through `headers["routecraft.id"]`, and `agent(name, {
 * session })` is the same override for a conversation. The friendly name
 * is `title`.
 */
export type AgentSessionKey = string;

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
 * What the store holds for one session, in the deferral record's opaque
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
   * Who the conversation belongs to: the subject of the principal whose
   * turn opened it, or `null` when no principal did.
   *
   * This is the gate for listing and reading a session over a protocol
   * surface. {@link AgentSessionRuntime.summaries} and
   * {@link AgentSessionRuntime.summary} take a scope and answer only what
   * that scope owns, so a caller cannot see or address another caller's
   * conversation, and an absent session and a foreign one answer alike.
   *
   * It is not an authorization boundary inside a route. Who may post into
   * a session is still the route's `.authorize()`, and a turn runs under
   * the principal of the exchange it runs on.
   */
  readonly owner?: string | null;
  /**
   * The directory the session is bound to, absolute. Set when the session
   * is opened and reported as ACP's `cwd`; absent for a session opened by
   * a route rather than by an editor.
   */
  readonly cwd?: string;
  /** Human-readable title, for a listing. */
  readonly title?: string;
  /** Per-session choices applied over the agent's registered options. */
  readonly overrides?: AgentSessionOverrides;
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
  readonly deferral?: AgentSessionDeferral;
  /**
   * The continuation about to be stored, named before the deferral exists and
   * cleared once `deferral` names it. A crash between those two writes leaves
   * this set with `deferral` unset, which is how the next boot finds an aside
   * deferral nothing else references and releases it; an aside deferral carries no
   * expiry, so nothing else would.
   */
  readonly deferring?: AgentSessionDeferral;
  /** Completed turns. */
  readonly turns: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Where a session's stored continuation is. */
export interface AgentSessionDeferral {
  readonly deferralId: string;
  readonly routeId: string;
}

/**
 * What a session deferral stores as its step state, so the revived step knows
 * it re-enters as a turn and not as a deferred tool loop. The transcript and
 * the inbox stay in the session record; this names them, it does not
 * carry them.
 *
 * @internal
 */
export interface AgentSessionDeferralMarker {
  readonly kind: "agent-session-deferral";
  readonly agent: string;
  readonly session: string;
  readonly deferralId: string;
}

/** @internal */
export function isSessionDeferralMarker(
  value: unknown,
): value is AgentSessionDeferralMarker {
  const marker = value as
    Partial<AgentSessionDeferralMarker> | null | undefined;
  return (
    marker !== null &&
    typeof marker === "object" &&
    marker.kind === "agent-session-deferral" &&
    typeof marker.agent === "string" &&
    typeof marker.session === "string" &&
    typeof marker.deferralId === "string"
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
  /**
   * The turn that produced a `replied` or `interrupted` outcome. Several
   * callers whose messages one turn consumed receive the same value, which
   * is how a consumer holding requests open (the ACP mount) tells one
   * batched reply from several. Absent on `queued` and `idle`.
   *
   * @internal
   */
  readonly turn?: string;
}

/** A session as the management API lists it. */
export interface AgentSessionSummary {
  readonly agent: string;
  readonly session: string;
  /** Who the conversation belongs to, or `null` when no principal opened it. */
  readonly owner: string | null;
  /** The directory the session is bound to, when it was opened with one. */
  readonly cwd?: string;
  /** Human-readable title, when the session was opened with one. */
  readonly title?: string;
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
  readonly deferred: boolean;
  /** Transcript length, in messages. */
  readonly messages: number;
  readonly turns: number;
  readonly updatedAt: string;
}
