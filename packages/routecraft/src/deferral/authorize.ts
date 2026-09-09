import type { CraftContext } from "../context.ts";
import type { Principal } from "../auth/types.ts";
import { markRestored } from "../auth/restored.ts";
import { HeadersKeys } from "../exchange.ts";
import { rcError } from "../error.ts";
import { decodePersistable } from "./serialize.ts";
import type { Deferral } from "./types.ts";

/**
 * The record, as the resume route's `authorize` hook sees it.
 *
 * Deliberately no access to the deferred body. The hook runs BEFORE the
 * resuming principal has been authorized and before the record's own
 * lifecycle is disclosed, so a body-reading hook would put the deferred
 * payload in front of exactly the party the check exists to reject.
 */
export interface DeferralRecordView {
  /** Deferral identity, the same value the acknowledgment carried. */
  readonly id: string;
  /**
   * Whatever the deferring step attached at deferral.
   *
   * The framework never reads it: this is where the deferral carries the
   * application's own policy inputs. A defer site that snapshots its policy
   * here gets "policy travels with the deferral" for free, because the record
   * is what the hook reads and editing the site cannot reach it.
   *
   * On the agent surface a tool handler supplies it, which means the MODEL
   * influenced it, and the model has read whatever untrusted tool output is
   * in its thread. Treat it as what the defer site chose, not as a fact the
   * framework vouches for.
   */
  readonly meta?: unknown;
  /** Route the deferred exchange belongs to. Not the resume ingress route. */
  readonly routeId: string;
  readonly deferredAt: Date;
  readonly expiresAt?: Date;
}

/**
 * What a `.resume({ authorize })` hook is handed.
 *
 * The two principals are not the same kind of thing, and the types say so.
 * `principal` was verified live by this ingress route's own
 * `.authenticate()`. `deferred` came back out of the store, so it is marked
 * restored (`auth/restored.ts`) and `authorize()` refuses it anywhere it is
 * offered as a credential; here it is reference data, which is what makes a
 * "not the requester" comparison expressible at all.
 */
export interface ResumeAuthorizerInput {
  /** Who is resuming, verified live by this route. Anonymous when it verified nobody. */
  readonly principal: Principal | undefined;
  /** Who deferred the exchange, restored from storage. Never a credential. */
  readonly deferred: Principal | undefined;
  /**
   * The submission, exactly as it arrived.
   *
   * Raw at hook time: `schema` validation runs only once the hook has
   * passed, so a hook that refuses a submission spends nothing and a
   * malformed one never reaches the validator. A hook that reads into this
   * is reading unvalidated input and should narrow it itself.
   */
  readonly payload: unknown;
  readonly record: DeferralRecordView;
}

/**
 * Decides whether this principal may resume this deferral.
 *
 * The framework has no opinion about what makes a resuming principal
 * legitimate: it guarantees that the decision happens before the single-use
 * claim is spent and that a "no" costs the rightful principal nothing. What
 * "no" means is this function's business.
 *
 * Returning false, throwing, and failing to settle before the route stops
 * or its `.timeout()` fires are one refusal on the wire; the log
 * distinguishes them.
 */
export type ResumeAuthorizer = (
  input: ResumeAuthorizerInput,
) => boolean | Promise<boolean>;

/**
 * Read the deferred principal back off a stored record.
 *
 * Marked restored on the way out, so the one object in the resume path that
 * came from storage rather than from a live verification cannot be mistaken
 * for a credential by anything downstream, the hook included.
 *
 * @internal
 */
export function deferredPrincipal(deferral: Deferral): Principal | undefined {
  const stored = deferral.exchange.headers[HeadersKeys.AUTH_PRINCIPAL];
  if (stored === undefined || typeof stored !== "object" || stored === null) {
    return undefined;
  }
  return markRestored(decodePersistable(stored) as Principal);
}

/**
 * The resume credential names the call it belongs to.
 *
 * A batch of parallel tool calls mints one credential per call against a
 * single record, because only one of them will win the deferral and the losers'
 * recipients must not be able to resume the winner's deferral. The record
 * records which call it belongs to and the credential carries the same
 * value as its `sub` claim, so the pairing is checked here.
 *
 * Both mismatched arms fail closed on purpose. A credential with no claim
 * presented against a per-call record is a credential minted before the
 * binding existed; a claim-carrying credential presented against a record
 * with no binding is a claim nothing checked. Passing either would make the
 * binding advisory, and an advisory binding is not one.
 *
 * @throws RC5055 when the credential does not name this record's call
 *
 * @internal
 */
export function checkCallBinding(
  deferral: Deferral,
  claimed: string | undefined,
): void {
  if (deferral.callBinding === claimed) return;
  throw rcError("RC5055", undefined, {
    message: `The resume credential presented for deferral "${deferral.id}" was not minted for the call this record is deferred on.`,
  });
}

/**
 * Build the record view handed to the hook.
 *
 * @internal
 */
export function recordView(deferral: Deferral): DeferralRecordView {
  return {
    id: deferral.id,
    ...(deferral.meta !== undefined ? { meta: deferral.meta } : {}),
    routeId: deferral.routeId,
    deferredAt: deferral.deferredAt,
    ...(deferral.expiresAt !== undefined
      ? { expiresAt: deferral.expiresAt }
      : {}),
  };
}

/**
 * Run the resume route's `authorize` hook.
 *
 * Bounded by the ingress route's own abort signal rather than by a framework
 * knob: the hook is ordinary code on a running route, so its bound is the
 * route's stop signal, widened by an enclosing `.timeout()` where the route
 * declares one. Stop has to be in there: without it a resume route with no
 * `.timeout()` could never interrupt a hook that never settles, and an
 * unsettled hook holds the step, which holds `drain()`. What the framework
 * owns is that such a hook can never fall through to the claim.
 *
 * Three refusals, one wire message. False is a decision, a throw is a hook
 * that broke, and an abort is a hook that never settled; the log
 * distinguishes them for the operator and the caller sees the same RC5056
 * for all three, because a hook whose failures are distinguishable from
 * outside is an oracle for what it knows.
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
        deferralId: input.record.id,
        routeId: input.record.routeId,
        principal: input.principal?.subject,
        outcome,
        ...(err !== undefined ? { err } : {}),
      },
      "A .resume({ authorize }) hook refused a resume",
    );
    return rcError("RC5056", undefined, {
      message: `The resume route's authorize hook refused this principal for deferral "${input.record.id}".`,
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
const ABORTED = Symbol("routecraft.deferral.authorize.aborted");

function isRefusal(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { rc?: unknown }).rc === "RC5056"
  );
}
