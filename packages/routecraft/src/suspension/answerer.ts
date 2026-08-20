import type { CraftContext } from "../context.ts";
import type { Principal } from "../auth/types.ts";
import { markRestored } from "../auth/restored.ts";
import { HeadersKeys } from "../exchange.ts";
import { rcError } from "../error.ts";
import { decodePersistable } from "./serialize.ts";
import type { AnswerPolicy, Suspension } from "./types.ts";

/**
 * How long an `authorize()` predicate may run before it is refused.
 *
 * The predicate sits inside the pre-claim window, so every millisecond it
 * spends is a millisecond the deadline can elapse under and the sweeper can
 * take an expiry claim in. The common predicate is a pure comparison over
 * claims that `.authenticate()` already resolved at the ingress, so five
 * seconds is generous for what it is for, and a predicate that needs longer
 * is making a network call inside a security window that should not
 * contain one.
 */
export const DEFAULT_AUTHORIZE_TIMEOUT = "5s";

/**
 * The non-secret facts about a parked question, as an `authorize()`
 * predicate sees them.
 *
 * Deliberately no access to the parked body. The predicate runs BEFORE the
 * answerer has been authorized, so a body-reading predicate would put the
 * parked payload in front of exactly the party the check exists to reject,
 * and would turn every refusal into an oracle for whoever holds a
 * structurally valid token.
 */
export interface SuspensionFacts {
  /** Suspension identity, the same value the acknowledgment carried. */
  readonly id: string;
  /** Route the parked exchange belongs to. Not the resume ingress route. */
  readonly routeId: string;
  /** Index of the suspending step within that route. */
  readonly position: number;
  /** Channel this record was parked on, when the site declared one. */
  readonly key?: string;
  /**
   * Human-facing question the suspending step asked.
   *
   * Authored by the suspending step; on the agent surface that step is the
   * MODEL, and the model has read whatever untrusted tool output is in its
   * thread. Route on it, log it, render it, but do not branch an
   * authorization decision on it.
   */
  readonly question?: string;
  /**
   * Machine-facing reason the suspending step gave. Carries the same
   * authorship hazard as {@link SuspensionFacts.question}.
   */
  readonly reason?: string;
  readonly suspendedAt: Date;
  readonly expiresAt?: Date;
}

/**
 * What an `authorize()` predicate is handed.
 *
 * The two principals are not the same kind of thing, and the types say so.
 * `answerer` was verified live by the resume ingress's own
 * `.authenticate()`. `parked` came back out of the store, so it is marked
 * restored (`auth/restored.ts`) and `authorize()` refuses it anywhere it is
 * offered as a credential; here it is reference data, which is what makes
 * a "not the requester" comparison expressible at all.
 */
export interface ResumeAuthorizerInput {
  /** Who is answering, verified live at the resume ingress. */
  readonly answerer: Principal;
  /** Who parked the exchange, restored from storage. Never a credential. */
  readonly parked?: Principal;
  readonly suspension: SuspensionFacts;
}

/**
 * Predicate deciding whether this answerer may answer this question.
 *
 * Returning false and throwing are the same refusal on the wire; a thrown
 * cause is logged at the boundary and never returned, so the predicate
 * cannot be used as an oracle for what it knows.
 */
export type ResumeAuthorizer = (
  input: ResumeAuthorizerInput,
) => boolean | Promise<boolean>;

/**
 * Whether a declarative policy constrains anything at all.
 *
 * An unconstrained policy needs no answerer identity, which is what keeps a
 * plain single-approver flow working over a dumb-transport ingress. Any
 * constraint at all is a comparison against the answerer, so the absence of
 * an answerer becomes a refusal rather than a pass.
 *
 * @internal
 */
export function policyConstrains(policy?: AnswerPolicy): boolean {
  if (!policy) return false;
  if (policy.scopes !== undefined && policy.scopes.length > 0) return true;
  return policy.sub !== undefined && policy.sub !== "any";
}

/**
 * Read the parked principal back off a stored record.
 *
 * Marked restored on the way out, so the one object in the resume path that
 * came from storage rather than from a live verification cannot be mistaken
 * for a credential by anything downstream, the predicate included.
 *
 * @internal
 */
export function parkedPrincipal(suspension: Suspension): Principal | undefined {
  const stored = suspension.exchange.headers[HeadersKeys.AUTH_PRINCIPAL];
  if (stored === undefined || typeof stored !== "object" || stored === null) {
    return undefined;
  }
  return markRestored(decodePersistable(stored) as Principal);
}

/**
 * Band 1: the resume credential names the question it is answering.
 *
 * A batch of parallel tool calls mints one credential per call against a
 * single record, because only one of them will win the park and the losers'
 * approvers must not be able to answer the winner's question. The record
 * records which call it belongs to and the credential carries the same
 * value as its `sub` claim, so the pairing is checked here.
 *
 * Both mismatched arms fail closed on purpose. A credential with no claim
 * presented against a per-call record is a credential minted before the
 * binding existed; a claim-carrying credential presented against a record
 * with no binding is a claim nothing checked. Passing either would make the
 * binding advisory, and an advisory binding is not one.
 *
 * @throws RC5055 when the credential does not name this record's question
 *
 * @internal
 */
export function checkCallBinding(
  suspension: Suspension,
  claimed: string | undefined,
): void {
  if (suspension.callBinding === claimed) return;
  throw rcError("RC5055", undefined, {
    message: `The resume credential presented for suspension "${suspension.id}" was not minted for the question this record is parked on.`,
  });
}

/**
 * Band 1: this door serves the channel the record was parked on.
 *
 * A door that declares no keys serves every channel, which is the
 * single-door default. Once a door declares keys it serves those and
 * nothing else, so a compromised or misconfigured ingress is bounded by
 * what it was pointed at rather than by what happens to be parked.
 *
 * @throws RC5057 when the door does not serve this record's channel
 *
 * @internal
 */
export function checkChannel(
  suspension: Suspension,
  keys: ReadonlyArray<string> | undefined,
): void {
  if (!keys || keys.length === 0) return;
  if (suspension.key !== undefined && keys.includes(suspension.key)) return;
  throw rcError("RC5057", undefined, {
    message: suspension.key
      ? `Suspension "${suspension.id}" is parked on channel "${suspension.key}", which this .resume() door does not serve.`
      : `Suspension "${suspension.id}" is parked on no channel, and this .resume() door serves only ${keys.map((key) => `"${key}"`).join(", ")}.`,
  });
}

/**
 * Band 1: the declarative floor the record was parked under.
 *
 * Read from the RECORD, never from the live site. Policy travels with the
 * question: an approver was promised a floor when the question was asked,
 * and editing the site afterwards must not weaken what an outstanding
 * question accepts. The site's copy governs future parks only.
 *
 * The predicate half is checked for PRESENCE here and evaluated in band 3.
 * A record parked under a predicate still needs an identity to evaluate it
 * against, and discovering that only at the predicate would mean an
 * unauthenticated ingress had already reached the destructive lifecycle
 * arms.
 *
 * @param suspension - The stored record, carrying the policy it parked under
 * @param answerer - Who the resume ingress verified, if it verified anyone
 * @throws RC5056 when the floor is not met, or cannot be evaluated because
 *   the ingress resolved no principal to evaluate it against
 *
 * @internal
 */
export function checkAnswerPolicy(
  suspension: Suspension,
  answerer: Principal | undefined,
): void {
  const policy = suspension.answer;
  const constrained = policyConstrains(policy);
  if (!constrained && !suspension.hasAuthorizer) return;

  const refuse = (detail: string): never => {
    throw rcError("RC5056", undefined, {
      message: `Suspension "${suspension.id}" declares who may answer it, and ${detail}`,
    });
  };

  if (!answerer) {
    return refuse(
      "the .resume() route that presented this token resolves no principal, so there is nothing to check the policy against. Add .authenticate() to the resume route: a declared answerer policy on an unauthenticated door fails closed rather than degrading to whoever holds the link.",
    );
  }
  if (!constrained) return;

  const required = policy?.scopes ?? [];
  if (required.length > 0) {
    const held = new Set(answerer.scopes ?? []);
    const missing = required.filter((scope) => !held.has(scope));
    if (missing.length > 0) {
      return refuse(
        `this answerer is missing ${missing.map((scope) => `"${scope}"`).join(", ")}.`,
      );
    }
  }

  const relation = policy?.sub;
  if (relation === undefined || relation === "any") return;

  // Presence is required on BOTH sides before either arm is decided. A
  // machine principal authenticated by API key legitimately carries scopes
  // and no subject, so an equality test alone would let "same" mean "any
  // principal that also lacks a subject" and "different" pass by accident
  // on the very pair it exists to reject.
  const answering = nonEmpty(answerer.subject);
  const parked = nonEmpty(parkedPrincipal(suspension)?.subject);
  if (!answering || !parked) {
    return refuse(
      `it compares subjects, and ${!answering ? "this answerer carries no subject claim" : "the parked principal carries no subject claim"}.`,
    );
  }

  if (relation === "same" && answering !== parked) {
    return refuse("only the principal that parked it may answer.");
  }
  if (relation === "different" && answering === parked) {
    return refuse("the principal that parked it may not answer it.");
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Band 3: run the site's `authorize()` predicate under a deadline.
 *
 * Bounded because it sits in the pre-claim window: an unbounded predicate
 * lets an answerer's rightful claim elapse under it, and lets the sweeper
 * take an expiry lease mid-call. The caller re-checks the suspension's own
 * deadline once this resolves, so an overrun is reported as the expiry it
 * is rather than as an authorization failure.
 *
 * Three refusals, one wire message. False is a decision, a throw is a
 * predicate that broke, and a timeout is a predicate that did not answer;
 * the log distinguishes them for the operator and the answerer sees the
 * same RC5056 for all three, because a predicate whose failures are
 * distinguishable from outside is an oracle for what it knows.
 *
 * @throws RC5056 on false, on a thrown cause, and on timeout
 *
 * @internal
 */
export async function runAuthorizer(
  authorize: ResumeAuthorizer,
  input: ResumeAuthorizerInput,
  timeoutMs: number,
  logger: CraftContext["logger"],
): Promise<void> {
  const refused = (outcome: string, err?: unknown): Error => {
    logger.warn(
      {
        suspensionId: input.suspension.id,
        routeId: input.suspension.routeId,
        position: input.suspension.position,
        answerer: input.answerer.subject,
        outcome,
        ...(err !== undefined ? { err } : {}),
      },
      "An authorize() predicate refused a resume",
    );
    return rcError("RC5056", undefined, {
      message: `Suspension "${input.suspension.id}" declares an authorize() predicate and it refused this answerer.`,
    });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verdict = await Promise.race([
      (async () => authorize(input))(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (verdict !== true) throw refused("returned false");
  } catch (err) {
    if (err === TIMED_OUT) {
      throw refused(`did not settle within ${timeoutMs}ms`);
    }
    // A refusal this function already built and logged. Re-logging it as a
    // predicate that threw would double-count it and misname it.
    if (isRefusal(err)) throw err;
    throw refused("threw", err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Sentinel for the timeout arm, so it is distinguishable from a thrown cause. */
const TIMED_OUT = Symbol("routecraft.suspension.authorize.timeout");

function isRefusal(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { rc?: unknown }).rc === "RC5056"
  );
}
