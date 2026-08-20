import type { CraftContext } from "../context.ts";
import type { Principal } from "../auth/types.ts";
import { markRestored } from "../auth/restored.ts";
import { HeadersKeys } from "../exchange.ts";
import { rcError } from "../error.ts";
import { decodePersistable } from "./serialize.ts";
import type { Suspension } from "./types.ts";

/**
 * The record, as the resume route's `authorize` hook sees it.
 *
 * Deliberately no access to the parked body. The hook runs BEFORE the
 * answerer has been authorized and before the record's own lifecycle is
 * disclosed, so a body-reading hook would put the parked payload in front
 * of exactly the party the check exists to reject.
 */
export interface SuspensionRecordView {
  /** Suspension identity, the same value the acknowledgment carried. */
  readonly id: string;
  /**
   * Whatever the suspending step attached at park.
   *
   * The framework never reads it: this is where the question carries the
   * application's own policy inputs. A parker that snapshots its policy
   * here gets "policy travels with the question" for free, because the
   * record is what the hook reads and editing the site cannot reach it.
   *
   * On the agent surface a tool handler supplies it, which means the MODEL
   * influenced it, and the model has read whatever untrusted tool output is
   * in its thread. The same applies to {@link SuspensionRecordView.question}
   * and {@link SuspensionRecordView.reason}. Treat all three as what the
   * parker chose, not as facts the framework vouches for.
   */
  readonly meta?: unknown;
  /** Human-facing question the suspending step asked. */
  readonly question?: string;
  /** Machine-facing reason the suspending step gave. */
  readonly reason?: string;
  /** Route the parked exchange belongs to. Not the resume ingress route. */
  readonly routeId: string;
  /** Index of the suspending step within that route. */
  readonly position: number;
  readonly suspendedAt: Date;
  readonly expiresAt?: Date;
}

/**
 * What a `.resume({ authorize })` hook is handed.
 *
 * The two principals are not the same kind of thing, and the types say so.
 * `answerer` was verified live by this ingress route's own
 * `.authenticate()`. `parked` came back out of the store, so it is marked
 * restored (`auth/restored.ts`) and `authorize()` refuses it anywhere it is
 * offered as a credential; here it is reference data, which is what makes a
 * "not the requester" comparison expressible at all.
 */
export interface ResumeAuthorizerInput {
  /** Who is answering, verified live by this route. Anonymous when it verified nobody. */
  readonly answerer: Principal | undefined;
  /** Who parked the exchange, restored from storage. Never a credential. */
  readonly parked: Principal | undefined;
  readonly record: SuspensionRecordView;
}

/**
 * Decides whether this answerer may answer this question.
 *
 * The framework has no opinion about what makes an answerer legitimate: it
 * guarantees that the decision happens before the single-use claim is spent
 * and that a "no" costs the rightful answerer nothing. What "no" means is
 * this function's business.
 *
 * Returning false, throwing, and failing to settle before the route's own
 * `.timeout()` are one refusal on the wire; the log distinguishes them.
 */
export type ResumeAuthorizer = (
  input: ResumeAuthorizerInput,
) => boolean | Promise<boolean>;

/**
 * Read the parked principal back off a stored record.
 *
 * Marked restored on the way out, so the one object in the resume path that
 * came from storage rather than from a live verification cannot be mistaken
 * for a credential by anything downstream, the hook included.
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
 * The resume credential names the question it is answering.
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
 * Build the record view handed to the hook.
 *
 * @internal
 */
export function recordView(suspension: Suspension): SuspensionRecordView {
  return {
    id: suspension.id,
    ...(suspension.meta !== undefined ? { meta: suspension.meta } : {}),
    ...(suspension.question !== undefined
      ? { question: suspension.question }
      : {}),
    ...(suspension.reason !== undefined ? { reason: suspension.reason } : {}),
    routeId: suspension.routeId,
    position: suspension.position,
    suspendedAt: suspension.suspendedAt,
    ...(suspension.expiresAt !== undefined
      ? { expiresAt: suspension.expiresAt }
      : {}),
  };
}

/**
 * Run the resume route's `authorize` hook.
 *
 * Bounded by the ingress route's own abort signal rather than by a
 * framework knob: the hook is ordinary code on a running route, and a route
 * that wants to bound it already has `.timeout()`. What the framework owns
 * is that an unsettled hook can never fall through to the claim.
 *
 * Three refusals, one wire message. False is a decision, a throw is a hook
 * that broke, and an abort is a hook that did not answer; the log
 * distinguishes them for the operator and the answerer sees the same
 * RC5056 for all three, because a hook whose failures are distinguishable
 * from outside is an oracle for what it knows.
 *
 * @throws RC5056 on false, on a thrown cause, and on an abort
 *
 * @internal
 */
export async function runAuthorizer(
  authorize: ResumeAuthorizer,
  input: ResumeAuthorizerInput,
  logger: CraftContext["logger"],
  signal?: AbortSignal,
): Promise<void> {
  const refused = (outcome: string, err?: unknown): Error => {
    logger.warn(
      {
        suspensionId: input.record.id,
        routeId: input.record.routeId,
        position: input.record.position,
        answerer: input.answerer?.subject,
        outcome,
        ...(err !== undefined ? { err } : {}),
      },
      "A .resume({ authorize }) hook refused a resume",
    );
    return rcError("RC5056", undefined, {
      message: `The resume route's authorize hook refused this answerer for suspension "${input.record.id}".`,
    });
  };

  let onAbort: (() => void) | undefined;
  try {
    const verdict = await Promise.race([
      (async () => authorize(input))(),
      new Promise<never>((_, reject) => {
        if (!signal) return;
        if (signal.aborted) {
          reject(ABORTED);
          return;
        }
        onAbort = () => {
          reject(ABORTED);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (verdict !== true) throw refused("returned false");
  } catch (err) {
    if (err === ABORTED)
      throw refused("did not settle before the route aborted");
    // A refusal this function already built and logged. Re-logging it as a
    // hook that threw would double-count it and misname it.
    if (isRefusal(err)) throw err;
    throw refused("threw", err);
  } finally {
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

/** Sentinel for the abort arm, so it is distinguishable from a thrown cause. */
const ABORTED = Symbol("routecraft.suspension.authorize.aborted");

function isRefusal(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { rc?: unknown }).rc === "RC5056"
  );
}
