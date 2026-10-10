import type { Authority } from "../authority.ts";
import type { CraftContext } from "../../context.ts";
import type { Principal } from "../../principal.ts";
import { HeadersKeys } from "../../exchange.ts";
import { rcError } from "../../error.ts";
import { rcCodeOf } from "../../brand.ts";
import { HOOK_ABORTED, settleOrAbort } from "../../shared/abort.ts";
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
 * Re-mints the principal the continuation runs with.
 *
 * `authorize` answers "may this person resume", boolean. This answers a
 * different question, "what authority does the continuation carry", and
 * they are deliberately two hooks: letting `authorize` return
 * `true | Principal` would mix the two and change the meaning of every
 * existing door's return type.
 *
 * Receives the same input `authorize` does, with the payload still raw. It
 * returns a LIVE principal, which means the door verified it now, against
 * whatever it verifies against; a restored one is refused. Throwing is a
 * refusal, and the right answer whenever the world moved under the park (the
 * person left, their roles changed, the agent's registration differs): refuse
 * and let the requester ask again, so the new park carries the new ring.
 * Never reconcile.
 *
 * What it may change is bounded to `scopes`, on the subject and on the
 * outermost actor, and capped by the scopes the refusal that parked the
 * exchange named. Everything else is compared structurally and any
 * difference is `RC5056`. See `.standards/security.md` §12.
 */
export type ResumeElevator = (
  input: ResumeAuthorizerInput,
) => Principal | Promise<Principal>;

/**
 * Read back the principal a deferred exchange parked with.
 *
 * The first half of reviving a parked exchange under a re-verified
 * identity: a plugin reads who parked it here, verifies that identity
 * against live state (a directory, a session, its own registry), and hands
 * the live result to `execution.resume(request, { reidentified })`, which
 * {@link reidentificationDeviation} then holds to being the same identity.
 * A resume door's `authorize` and `elevate` hooks receive the same value as
 * `deferred`.
 *
 * Marked restored on the way out, so the one object in the resume path that
 * came from storage rather than from a live verification cannot be mistaken
 * for a credential by anything downstream: `authorize()` refuses it, and
 * handing it back as `reidentified` is refused with `RC5056`. Use it as
 * reference data for what to verify, never as the identity to run as.
 *
 * @param deferral - The stored record, as `DeferralStore.get` returns it
 * @param authority - The application's authority (`authorityOf(context)`),
 *   which owns the restored mark
 * @returns The parked principal marked restored, or `undefined` when the
 *   exchange parked without one
 *
 * @example
 * ```ts
 * const record = await store.get(deferralId);
 * const parked = record && deferredPrincipal(record, authority);
 * const live = parked && (await directory.verify(parked.subject));
 * await c.execution.resume({ token, result }, { reidentified: live });
 * ```
 */
export function deferredPrincipal(
  deferral: Deferral,
  authority: Authority,
): Principal | undefined {
  const stored = deferral.exchange.headers[HeadersKeys.AUTH_PRINCIPAL];
  if (stored === undefined || typeof stored !== "object" || stored === null) {
    return undefined;
  }
  return authority.restore(decodePersistable(stored) as Principal);
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
  const refused = refusalOf("authorize", input, logger);
  try {
    const verdict = await settleOrAbort(() => authorize(input), signal);
    if (verdict !== true) throw refused("returned false");
  } catch (err) {
    if (err === HOOK_ABORTED)
      throw refused("did not settle before the route aborted");
    // A refusal this function already built and logged. Re-logging it as a
    // hook that threw would double-count it and misname it.
    if (isRefusal(err)) throw err;
    throw refused("threw", err);
  }
}

/**
 * What a refusal is logged as and answered with, per refusing check.
 *
 * The two door hooks are `.resume()` options and name themselves as such.
 * A re-identification is not a hook on any route: a plugin reviving a parked
 * exchange on its own behalf handed over a principal, and naming a
 * `.resume()` option there would send an operator looking for a hook nobody
 * declared.
 *
 * @internal
 */
const REFUSALS = {
  authorize: {
    log: "A .resume({ authorize }) hook refused a resume",
    message: (id: string) =>
      `The resume route's authorize hook refused this principal for deferral "${id}".`,
  },
  elevate: {
    log: "A .resume({ elevate }) hook refused a resume",
    message: (id: string) =>
      `The resume route's elevate hook refused this principal for deferral "${id}".`,
  },
  reidentify: {
    log: "A plugin-driven revival was refused its re-identified principal",
    message: (id: string) =>
      `The principal re-identified for deferral "${id}" is not the identity it parked with, verified live, so the revival was refused.`,
  },
} as const;

/**
 * Build the single refusal a resume check answers with, and log its cause.
 *
 * One builder, because every way a check refuses is required to be
 * indistinguishable from outside: each check has one `RC5056` and one fixed
 * message whatever the cause, and the operator's log is the only place the
 * causes are told apart. Asserting that property in several copies is how
 * it stops being true.
 *
 * @param principal - Who the log names as refused; the door's live
 *   principal unless the check refused a different one
 *
 * @internal
 */
function refusalOf(
  check: keyof typeof REFUSALS,
  input: ResumeAuthorizerInput,
  logger: CraftContext["logger"],
  principal: Principal | undefined = input.principal,
): (outcome: string, err?: unknown) => Error {
  const refusal = REFUSALS[check];
  return (outcome, err) => {
    logger.warn(
      {
        deferralId: input.record.id,
        routeId: input.record.routeId,
        principal: principal?.subject,
        outcome,
        ...(err !== undefined ? { err } : {}),
      },
      refusal.log,
    );
    return rcError("RC5056", undefined, {
      message: refusal.message(input.record.id),
    });
  };
}

/**
 * Run the resume route's `elevate` hook and hold its answer for the claim.
 *
 * Bounded and logged exactly as {@link runAuthorizer} is, and refused with
 * the same `RC5056` for the same reason: a hook whose failures can be told
 * apart from outside is an oracle for what it knows.
 *
 * WHERE this runs is the security property, not what it returns. It is
 * evaluated immediately after `authorize`, above the lifecycle disclosure
 * and above the claim, and its result is applied only once the claim is won.
 * Below either settling transition, a refused caller would burn the rightful
 * principal's single-use link and drive the approver notification with a
 * credential that was never theirs.
 *
 * @param bound - The scopes the park recorded as refused, which is the most
 *   the lend may add. Absent leaves nothing to lend within, so any widening
 *   is refused.
 * @returns The principal the continuation runs with
 * @throws RC5056 on a throw, an abort, a restored principal, a lend wider
 *   than `bound`, or any difference outside `scopes`
 *
 * @internal
 */
export async function runElevator(
  elevate: ResumeElevator,
  input: ResumeAuthorizerInput,
  logger: CraftContext["logger"],
  bound: readonly string[] | undefined,
  signal: AbortSignal | undefined,
  authority: Authority,
): Promise<Principal> {
  const refused = refusalOf("elevate", input, logger);
  let elevated: Principal;
  try {
    elevated = await settleOrAbort(() => elevate(input), signal);
  } catch (err) {
    if (err === HOOK_ABORTED)
      throw refused("did not settle before the route aborted");
    if (isRefusal(err)) throw err;
    throw refused("threw", err);
  }

  // The positive check: a restored record and a plain object both fail it.
  if (!authority.isAuthentic(elevated)) {
    throw refused("returned a principal that was not verified live");
  }
  const deviation = elevationDeviation(input.deferred, elevated, bound);
  if (deviation) throw refused(deviation);
  return elevated;
}

/**
 * Compare a re-minted principal against the one that parked, and name the
 * first difference the rule does not allow.
 *
 * COMPARED, on the subject and on the outermost actor: `(issuer, subject)`,
 * `roles`, `subjectProfile`, `email`, `name`, `audience`, `clientId`;
 * `mayAct` on the subject; the actor chain's depth, and every prior actor
 * whole. These are the identity and policy inputs `.standards/security.md`
 * §12 names, and a door that changes one of them has substituted a different
 * party rather than lent authority to this one.
 *
 * NOT compared: `scopes`, which is the point; and `kind`, `scheme`,
 * `expiresAt`, `claims` and `userinfoClaims`, because a re-mint is by
 * construction a fresh verification and those describe HOW it was verified
 * rather than WHO. Comparing them would refuse every legitimate lend.
 *
 * Only the OUTERMOST actor may be lent to, per RFC 8693 section 4.1: prior
 * actors in a chain are audit data and never a policy input, so they are
 * compared whole.
 *
 * @returns A phrase naming the deviation, or `undefined` when the re-mint is
 *   within the rule
 *
 * @internal
 */
function elevationDeviation(
  parked: Principal | undefined,
  elevated: Principal,
  bound: readonly string[] | undefined,
): string | undefined {
  if (!parked) {
    // Nothing parked means nothing to lend within; `authorize` answers an anonymous park.
    return "returned a principal for a deferral that parked without one";
  }
  // An identity this function cannot compare (a looping actor chain) is not approved.
  let same: boolean;
  try {
    same = identicalJson(
      comparableIdentity(parked, "lendable"),
      comparableIdentity(elevated, "lendable"),
    );
  } catch {
    return "returned a principal that could not be compared with the parked one";
  }
  if (!same) {
    return "returned a principal differing from the parked one outside scopes";
  }
  const lent = lentScopes(parked, elevated);
  if (lent.length === 0) return undefined;
  if (!bound || bound.length === 0) {
    return "lent scopes for a deferral that recorded none as refused";
  }
  const overreach = lent.filter((scope) => !bound.includes(scope));
  if (overreach.length > 0) {
    return `lent scope(s) the refusal never named: ${overreach.join(", ")}`;
  }
  return undefined;
}

/**
 * Everything about a principal the identity rule compares. In `lendable`
 * mode `scopes` are stripped from the subject and the outermost actor and
 * kept everywhere else, which is what `elevate` lends within; in `same`
 * mode they are compared too, which is what a re-identification must hold.
 *
 * Built as a value and compared structurally rather than field by field, so
 * a field added to `Principal` is compared by default. Failing closed on a
 * new field is the right direction: a field nobody thought about must not be
 * silently lendable.
 *
 * @internal
 */
function comparableIdentity(
  principal: Principal,
  scopes: "lendable" | "same",
): unknown {
  const { actor } = principal;
  const lendable = (key: string): boolean =>
    scopes === "lendable" && key === "scopes";
  return {
    ...without(
      principal as unknown as Record<string, unknown>,
      (key) => VERIFICATION_FIELDS.has(key) || lendable(key) || key === "actor",
    ),
    ...(actor
      ? {
          // Only the outermost actor's scopes are lendable; prior actors
          // compare whole (RFC 8693 section 4.1).
          actor: without(
            actor as unknown as Record<string, unknown>,
            (key) => VERIFICATION_FIELDS.has(key) || lendable(key),
          ),
        }
      : {}),
  };
}

/**
 * Check a principal re-minted for the SAME identity a parked exchange
 * carried, and name the first way it is not.
 *
 * `execution.resume(request, { reidentified })` runs this itself and
 * refuses with `RC5056` on any answer but `undefined`, so a plugin calls it
 * only to learn, before resuming, whether its re-verification would pass:
 * to report a refusal in its own terms, or to skip a revival that would be
 * refused anyway. The returned phrase is for the plugin's operator log and
 * never for a caller, since it says which part of the identity moved.
 *
 * This is the rule a plugin-driven revival runs under, as opposed to a
 * resume door's `elevate`: nothing is being authorized and no authority is
 * being raised, so the re-mint must be the parked identity verified live
 * now, and nothing else. It is compared on the set `elevate` compares, with
 * `scopes` added on the subject and on every actor, and any difference in
 * either direction refuses it. A revival must not grant more than the park
 * held, and it must not quietly grant less either: if the person was
 * offboarded or their roles changed during the park, nothing runs in their
 * name, they ask again, and the new park carries the new state.
 *
 * A restored principal is refused by the same call, because running
 * restored is exactly what a re-identification exists to replace.
 *
 * @param parked - The principal the exchange parked with, read back restored
 * @param reminted - What the application re-verified from live state
 * @param authority - The application's authority, for the live brand
 * @returns A phrase naming the deviation, or `undefined` when the re-mint
 *   is the same identity verified live
 */
export function reidentificationDeviation(
  parked: Principal | undefined,
  reminted: Principal,
  authority: Authority,
): string | undefined {
  if (!authority.isAuthentic(reminted)) {
    return "returned a principal that was not verified live";
  }
  if (!parked) {
    return "returned a principal for a deferral that parked without one";
  }
  let same: boolean;
  try {
    same = identicalJson(
      comparableIdentity(parked, "same"),
      comparableIdentity(reminted, "same"),
    );
  } catch {
    return "returned a principal that could not be compared with the parked one";
  }
  return same
    ? undefined
    : "returned a principal differing from the parked one";
}

/**
 * Refuse a plugin-driven revival whose re-identified principal is not the
 * parked identity verified live. Refused with the `RC5056` the door hooks
 * answer with, for the same reason: a refusal whose cause can be told apart
 * from outside is an oracle for what the application knows. Its log line
 * and message name a re-identification rather than a `.resume()` hook.
 *
 * @throws RC5056 on a restored principal or any difference from the parked one
 *
 * @internal
 */
export function checkReidentified(
  reidentified: Principal,
  input: ResumeAuthorizerInput,
  logger: CraftContext["logger"],
  authority: Authority,
): Principal {
  const deviation = reidentificationDeviation(
    input.deferred,
    reidentified,
    authority,
  );
  if (deviation) {
    throw refusalOf("reidentify", input, logger, reidentified)(deviation);
  }
  return reidentified;
}

/**
 * The fields that describe HOW a principal was verified rather than WHO it
 * is. A re-mint changes all of them by construction, so comparing them would
 * refuse every legitimate lend.
 *
 * @internal
 */
const VERIFICATION_FIELDS: ReadonlySet<string> = new Set([
  "kind",
  "scheme",
  "expiresAt",
  "claims",
  "userinfoClaims",
]);

/**
 * Copy a record without the keys a predicate rejects.
 *
 * Expressed as an exclusion rather than a list of what to keep, so a field
 * added to `Principal` is compared by DEFAULT. Failing closed on a field
 * nobody has thought about is the right direction: the alternative silently
 * makes it lendable.
 *
 * @internal
 */
function without(
  record: Record<string, unknown>,
  drop: (key: string) => boolean,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !drop(key)),
  );
}

/**
 * The scopes the re-mint added, counted PER RING.
 *
 * Per ring rather than over the two merged, because the rings are not
 * interchangeable: a scope check reads the subject's ring alone unless the
 * gate opts in with `effective: true`. Merged, a door could move a scope the
 * park already held on the ACTOR onto the SUBJECT, lend nothing by the count,
 * and still satisfy a default subject-ring gate that had refused before the
 * park.
 *
 * Added only. Dropping a scope narrows authority, which no gate can be
 * opened by, so a door that hands back less than parked is within the rule.
 *
 * @internal
 */
function lentScopes(parked: Principal, elevated: Principal): string[] {
  const added = (
    from: readonly string[] | undefined,
    to: readonly string[] | undefined,
  ): string[] => {
    const held = new Set(from ?? []);
    return (to ?? []).filter((scope) => !held.has(scope));
  };
  return [
    ...added(parked.scopes, elevated.scopes),
    ...added(parked.actor?.scopes, elevated.actor?.scopes),
  ];
}

/**
 * Structural equality over plain data.
 *
 * `JSON.stringify` with sorted keys rather than a deep walk: both sides are
 * principal shapes, which the serialization rules already confine to plain
 * JSON data, and key order must not decide an identity comparison.
 *
 * @internal
 */
function identicalJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

/** @internal */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return item;
    }
    const record = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

function isRefusal(err: unknown): boolean {
  // By brand: a hook may reject with an object shaped like a refusal.
  return rcCodeOf(err) === "RC5056";
}
