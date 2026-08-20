import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CraftContext } from "../context.ts";
import { validateAgainst } from "../pipeline/validation.ts";
import { rcError } from "../error.ts";
import {
  type Exchange,
  DefaultExchange,
  HeadersKeys,
  setExchangeRoute,
  setResumeStepState,
} from "../exchange.ts";
import type { Route } from "../route.ts";
import type { Adapter, Step } from "../types.ts";
import {
  continuationTailHash,
  describePolicy,
  describeSchema,
} from "./hash.ts";
import {
  type ResumeAuthorizer,
  checkAnswerPolicy,
  checkCallBinding,
  checkChannel,
  parkedPrincipal,
  runAuthorizer,
} from "./answerer.ts";
import { SuspensionHeaders } from "./exchange-state.ts";
import { SUSPENSION_RUNTIME } from "./runtime-key.ts";
import {
  decodePersistable,
  deserializeExchange,
  encodePersistable,
} from "./serialize.ts";
import type { SuspendSite } from "./sites.ts";
import type { Principal } from "../auth/types.ts";
import type {
  PrincipalRef,
  SerializedOutcome,
  Suspension,
  SuspensionCasResult,
  SuspensionStore,
} from "./types.ts";

/**
 * What `.resume()`'s mapping function produces: which suspension to revive,
 * and the candidate answer to revive it with.
 *
 * The split is the boundary between the two halves of a resume. The mapping
 * function owns SHAPE (find the token in a mail reply, lift an approval out
 * of a chat webhook), because only the ingress route knows what its
 * transport looks like. Revival owns VALIDATION, because only the
 * suspension knows the schema the suspending step declared.
 */
export interface ResumeRequest {
  /** The signed token minted when the exchange parked. */
  token: string;
  /** The candidate answer, validated against the suspending step's `schema`. */
  result: unknown;
  /**
   * Who answered. Defaults to the ingress exchange's own principal, which
   * is the value worth recording: it was verified live on the route that
   * accepted the answer, unlike anything read back out of the store. Set it
   * explicitly only when the answerer is not the caller (an ops tool
   * resuming on someone's behalf).
   */
  resumedBy?: PrincipalRef;
}

/**
 * What the resume DOOR contributes, as opposed to what its mapper produced.
 *
 * Kept separate from {@link ResumeRequest} deliberately. The mapper is user
 * code shaping a transport payload, and a payload is exactly what an
 * attacker controls; letting it name the answerer or widen the door's
 * channels would let the untrusted half of an ingress choose what the
 * trusted half checks.
 *
 * @internal
 */
export interface ResumeDoor {
  /** Channels this door serves. Absent serves every channel. */
  readonly keys?: readonly string[];
  /** The principal this ingress route verified live, if any. */
  readonly answerer?: Principal;
}

/**
 * What `.resume()` puts in the ingress route's body once revival settles.
 *
 * The ingress route continues after this, which is what lets it answer the
 * approver's own channel ("thanks, the payout is on its way"). It therefore
 * reports how execution two ended rather than just that the token was
 * accepted.
 */
export interface ResumeAcknowledgment {
  /**
   * `"resumed"` when this call revived the exchange; `"duplicate"` when the
   * suspension had already been resumed and this is the cached terminal
   * outcome of that first revival. A duplicate re-runs nothing.
   */
  readonly status: "resumed" | "duplicate";
  readonly suspensionId: string;
  /** Route the revived exchange belongs to. Not the ingress route. */
  readonly routeId: string;
  /** How execution two ended. */
  readonly outcome: SerializedOutcome;
}

/**
 * Revive a parked exchange and run its continuation to completion.
 *
 * The order of checks is the security contract, and it runs in three bands.
 * The bands exist because the middle one is NOT inert: the deadline arm and
 * the continuation arm each take a compare-and-swap that settles the record
 * and drives the suspended route's error channel, which in practice sends
 * the approver a message. A credential that has no business here must be
 * refused before it can reach either, or the wrong holder can burn the
 * rightful answerer's claim and drive an outbound notification with it.
 *
 * **Band 1, from the record alone.** The token verifies (`RC5041`), the
 * suspension exists (`RC5046`), the credential was minted for THIS question
 * (`RC5055`), this door serves the record's channel (`RC5057`), and the
 * answerer meets the declarative floor the record parked under (`RC5056`).
 * Nothing here reads the live route or transitions anything, and it runs
 * BEFORE the settled-state disclosure, so a wrongly-bound holder learns only
 * "not your credential" rather than whether the record resumed, expired or
 * was denied.
 *
 * **Band 2, the lifecycle.** A duplicate gets the cached terminal outcome
 * rather than a second execution, an expired record `RC5047`, a denied one
 * `RC5050`. Its route is still registered and still leads to the same
 * continuation (`RC5048`), so an approval cannot authorize steps that were
 * edited under it. The hash is COMPARED non-destructively; only a mismatch
 * reached by a caller band 1 already accepted may settle the record.
 *
 * **Band 3, the expensive checks.** The site's `authorize()` predicate runs
 * under `suspension.authorizeTimeout` (`RC5056`), and the deadline is
 * re-checked immediately after it resolves so an overrun reports the expiry
 * it is (`RC5047`) rather than an authorization failure. Then the answer
 * satisfies the suspending step's `schema` (`RC5049`, in the ingress route
 * only), and the compare-and-swap out of `suspended` is won here and not by
 * a concurrent resume or the expiry sweeper.
 *
 * The declarative policy is enforced from the RECORD and never re-read from
 * the live site: policy travels with the question, so editing a site's
 * `answer` or `key` governs future parks only. The predicate cannot persist,
 * so its verbatim source rides the continuation hash instead and an edit
 * takes the `RC5048` re-ask.
 *
 * Every failure throws in the ingress route. A failure that leaves the
 * approver STRANDED (an expiry, a changed continuation, a denied
 * suspension) additionally re-enters the suspended route's error channel,
 * because only that route can notify and re-ask. A rejected answer
 * (`RC5049`) deliberately does not: it is a per-request input error rather
 * than a change in the world, the suspension stays resumable, and routing
 * it through the suspended route would let any token holder drive that
 * route's re-ask path with junk. The three refusals are the same: they leave
 * the record exactly as they found it.
 *
 * @param context - The context reviving the exchange (the ingress route's)
 * @param request - Token plus candidate answer, as the mapper produced them
 * @param door - What the ingress route itself declares and verified
 * @returns The acknowledgment for the ingress route's body
 *
 * @internal
 */
export async function reviveSuspension(
  context: CraftContext,
  request: ResumeRequest,
  door: ResumeDoor = {},
): Promise<ResumeAcknowledgment> {
  const runtime = context.getStore(SUSPENSION_RUNTIME);
  if (!runtime) {
    throw rcError("RC5052", undefined, {
      message:
        "Cannot resume: this context has no suspension runtime, so no token it was handed can be verified. Add suspension: {} to defineConfig.",
    });
  }

  const { id, sub } = runtime.signer.verify(request.token);
  const suspension = await runtime.store.get(id);
  if (!suspension) {
    throw rcError("RC5046", undefined, {
      message: `No suspension is stored under id "${id}".`,
    });
  }

  // Band 1. Record and credential only: no route lookup, no transition, no
  // disclosure. Placed above the settled return deliberately, so a holder
  // whose credential does not belong here cannot use the response to learn
  // the record's lifecycle state.
  checkCallBinding(suspension, sub);
  checkChannel(suspension, door.keys);
  checkAnswerPolicy(suspension, door.answerer);

  // Band 2.
  if (suspension.status !== "suspended") {
    return settled(suspension);
  }

  const route = context.getRouteById(suspension.routeId);
  if (!route) {
    throw rcError("RC5046", undefined, {
      message: `Suspension "${id}" belongs to route "${suspension.routeId}", which is not registered in this context. Resume must run in a context that has the suspended route.`,
    });
  }

  // Checked here as well as by the sweeper: an answer can arrive between
  // the deadline and the sweep that marks it, and resuming into a window
  // the route already declared closed is exactly what `ttl` rules out.
  //
  // The transition is what makes the re-ask exactly-once. Without the
  // compare-and-swap, every replay of one dead token would emit the event
  // again, run the suspended route's error channel again, and typically
  // send the approver another notification: an outbound-message amplifier
  // driven by a party the token does not authenticate. Winning the CAS is
  // the right to notify, and the sweeper competes for the same right.
  const deadline = suspension.expiresAt;
  if (deadline !== undefined && deadline.getTime() <= Date.now()) {
    const { cas, error } = await expireSuspension(
      context,
      runtime.store,
      route,
      {
        ...suspension,
        expiresAt: deadline,
      },
    );
    if (!cas.won) {
      // The winner is not necessarily the sweeper. A concurrent resume can
      // win `markResumed` right on the deadline, and that answer WAS
      // accepted: reporting an expiry to this caller would be a false
      // negative about work that is running. Whoever won says what
      // happened.
      if (cas.suspension) return settled(cas.suspension);
    }
    throw error;
  }

  const site = findSite(route, suspension);
  if (!site) {
    return await refuseContinuation(
      context,
      runtime.store,
      route,
      suspension,
      "suspend site removed",
      `Route "${suspension.routeId}" no longer has a .suspend() at position ${suspension.position}.`,
    );
  }

  // For a static site: the descriptor of the LIVE schema, never the stored
  // one. The stored descriptor is what was folded into
  // `suspension.continuationHash` at park time, so comparing it against
  // itself is inert and a widened schema would resume into a contract its
  // approver never saw. The suspending step's own definition is excluded
  // from the hashed tail by design, which makes this descriptor, and the
  // policy descriptor beside it, the ONLY representation of that step in
  // the digest.
  //
  // For a re-entrant site the stored descriptor is all there is: the live
  // schema was raised inside the step's own code and cannot be read back
  // off the route, so the schema arm IS inert there. The step itself heads
  // the hashed tail instead, so its definition is covered; the schema is
  // the same residue class as the behaviour of what the tail calls.
  //
  // The policy descriptor covers the `authorize()` closure, which cannot
  // persist. Its declarative siblings (`answer`, `key`) do persist and are
  // enforced from the record in band 1, so they are deliberately NOT in the
  // digest: an edit to them governs future parks and leaves outstanding
  // questions on the policy their approver was promised.
  const current = continuationTailHash(
    site.site.continuation,
    site.schema ? describeSchema(site.schema) : suspension.schema,
    describePolicy(site.authorize),
  );
  if (current !== suspension.continuationHash) {
    // Reached only by a caller band 1 accepted. `refuseContinuation` denies
    // the record and drives the approver notification, so a holder who
    // failed band 1 must never get here: they would burn the rightful
    // answerer's claim and send the message themselves.
    return await refuseContinuation(
      context,
      runtime.store,
      route,
      suspension,
      "continuation changed",
      `Route "${suspension.routeId}" changed after position ${suspension.position} while this exchange was parked, so the stored answer no longer authorizes what would run.`,
    );
  }

  // Band 3. The predicate runs last of the refusals: band 1 has excluded
  // credentials that do not belong here, and the hash arm has confirmed the
  // predicate about to run is the one this record parked under.
  if (site.authorize) {
    // Band 1 refuses an anonymous door on a record that recorded a
    // predicate, so this is normally already settled. It is re-checked
    // rather than asserted because a record written before the site grew
    // its predicate carries no such marker, and handing the predicate an
    // undefined answerer would refuse through its throw arm and log the
    // misconfiguration as a broken predicate.
    if (!door.answerer) {
      throw rcError("RC5056", undefined, {
        message: `Suspension "${id}" is answered by a site that declares an authorize() predicate, and the .resume() route that presented this token resolves no principal, so there is nothing to check it against. Add .authenticate() to the resume route.`,
      });
    }
    const parked = parkedPrincipal(suspension);
    await runAuthorizer(
      site.authorize,
      {
        answerer: door.answerer,
        ...(parked !== undefined ? { parked } : {}),
        suspension: {
          id,
          routeId: suspension.routeId,
          position: suspension.position,
          ...(suspension.key !== undefined ? { key: suspension.key } : {}),
          ...(suspension.question !== undefined
            ? { question: suspension.question }
            : {}),
          ...(suspension.reason !== undefined
            ? { reason: suspension.reason }
            : {}),
          suspendedAt: suspension.suspendedAt,
          ...(suspension.expiresAt !== undefined
            ? { expiresAt: suspension.expiresAt }
            : {}),
        },
      },
      runtime.authorizeTimeoutMs,
      context.logger,
    );
    // A predicate may await, so the window it opened has to be paid for
    // here rather than at the post-claim re-check: an answer that arrived
    // in time and then sat behind a slow predicate must report the expiry
    // it hit, not an authorization failure it never had.
    if (
      suspension.expiresAt !== undefined &&
      suspension.expiresAt.getTime() <= Date.now()
    ) {
      const { cas, error } = await expireSuspension(
        context,
        runtime.store,
        route,
        { ...suspension, expiresAt: suspension.expiresAt },
      );
      if (!cas.won && cas.suspension) return settled(cas.suspension);
      throw error;
    }
  }

  // Validation runs against the LIVE schema read off the route: a Standard
  // Schema is an object with a validate function and cannot be persisted.
  // Reaching here means the hash check above already confirmed that live
  // schema is the one the approval was taken against.
  //
  // A re-entrant site has no live schema to read back (it was raised inside
  // the step's own code), so the check is skipped THERE AND ONLY THERE: the
  // raw answer is handed to the re-entering step as its suspended call's
  // payload, and the step is the validator. A token holder can therefore
  // resume a re-entrant suspension with any JSON; the consuming step (the
  // agent tier's model loop is the shipped case) must treat it as untrusted
  // input, which a tool result already is.
  let answer: unknown = request.result;
  if (site.schema) {
    const result = await validateAgainst(site.schema, request.result);
    if (!result.ok) {
      // Ingress only, deliberately: unlike an expiry or a changed
      // continuation, a malformed answer is not a change in the world the
      // suspended route has to react to. It is a per-request input error, and
      // re-entering the suspended route's error channel for it would hand any
      // token holder a lever to drive that route's re-ask path (approver
      // notifications included) with junk. The suspension is left resumable,
      // so the answerer simply corrects the payload; shaping a reply to a bad
      // answer is the ingress route's own `.error()` handler's job.
      throw rcError("RC5049", result.message, {
        message: `The answer for suspension "${id}" does not satisfy its declared schema: ${result.message}`,
      });
    }
    answer = result.value;
  }

  const resumedAt = new Date();
  const cas = await runtime.store.markResumed(id, {
    at: resumedAt,
    ...(request.resumedBy ? { by: request.resumedBy } : {}),
  });
  if (!cas.won) {
    // Lost the race. Whoever won says what happened: a concurrent resume
    // yields its cached outcome, the sweeper an expiry, a cancellation a
    // denial. Reading the post-attempt record avoids a second store read.
    if (!cas.suspension) {
      throw rcError("RC5046", undefined, {
        message: `Suspension "${id}" disappeared while it was being resumed.`,
      });
    }
    return settled(cas.suspension);
  }

  // The deadline is re-checked AFTER winning the transition. The check
  // above ran before validating the answer, and validation is a user
  // schema: it can await. Without this, an answer that arrived in time but
  // validated slowly would run the continuation past the window its route
  // declared, which is the one thing `ttl` promises it will not do.
  if (
    suspension.expiresAt !== undefined &&
    suspension.expiresAt.getTime() <= Date.now()
  ) {
    const expiry = rcError("RC5047", undefined, {
      message: `Suspension "${id}" expired at ${suspension.expiresAt.toISOString()} while its answer was being validated.`,
    });
    // Winning `markResumed` means the sweeper cannot also report this, so
    // the notification is ours to send exactly once.
    await runtime.store.recordTerminal(id, {
      status: "failed",
      error: { rc: "RC5047", message: expiry.message },
      at: resumedAt,
    });
    context.emit("route:exchange:expired", {
      routeId: suspension.routeId,
      exchangeId: exchangeIdOf(suspension),
      correlationId: correlationIdOf(suspension),
      suspensionId: id,
      expiresAt: suspension.expiresAt,
    });
    throw await reask(context, route, suspension, expiry);
  }

  // Everything from here is under one catch, because this resume has won
  // `markResumed` and nothing else will ever settle the record. A throw
  // between the transition and `recordTerminal` (a stored exchange the
  // deserializer refuses, a `route:exchange:resumed` subscriber that fails)
  // would otherwise leave the suspension `resumed` with no terminal
  // forever, and every later answer would be told the first resume has not
  // recorded an outcome yet. Recording the failure keeps a replay
  // idempotent, which is the contract a claimed suspension owes.
  let outcome: SerializedOutcome;
  try {
    const exchange = rehydrate(context, route, suspension, {
      result: answer,
      resumedAt,
      ...(request.resumedBy ? { resumedBy: request.resumedBy } : {}),
    });
    // The step-owned closure state goes back to the step that parked it,
    // through internals rather than headers: it is runtime context for one
    // re-entrant execution on this process, never exchange state, and must
    // not be re-serialized into a second park.
    if (site.site.reentrant && suspension.stepState !== undefined) {
      setResumeStepState(exchange, decodePersistable(suspension.stepState));
    }

    context.emit("route:exchange:resumed", {
      routeId: suspension.routeId,
      exchangeId: exchange.id,
      correlationId: exchange.headers[HeadersKeys.CORRELATION_ID] as string,
      suspensionId: id,
      position: suspension.position,
      ...(request.resumedBy ? { resumedBy: request.resumedBy } : {}),
    });

    outcome = await runContinuation(
      route,
      exchange,
      site.site.continuation,
      resumedAt,
    );
  } catch (error) {
    // Best-effort, and the ordering is the point: the original error must
    // reach the ingress route whatever the store does. A throw from
    // `recordTerminal` here would mask it AND leave the record unsettled,
    // reproducing one level up the condition this block exists to remove.
    // `rc` is carried like the expiry path carries RC5047, so a duplicate
    // resume and an operator dashboard see the code rather than prose.
    const failure = error as { rc?: string; message?: string } | undefined;
    try {
      await runtime.store.recordTerminal(id, {
        status: "failed",
        error: {
          ...(typeof failure?.rc === "string" ? { rc: failure.rc } : {}),
          message: failure?.message ?? "the revival failed",
        },
        at: resumedAt,
      });
    } catch (unrecorded) {
      route.logger.error(
        { suspensionId: id, err: unrecorded },
        "Could not record the terminal outcome of a failed revival. The suspension stays resumed with no outcome and needs an operator.",
      );
    }
    throw error;
  }
  try {
    await runtime.store.recordTerminal(id, outcome);
  } catch (err) {
    // The work is DONE: destinations fired and the outcome below is true.
    // Throwing here would tell the answerer the work failed after it
    // succeeded, and the boot scan would later count the record as a
    // half-run continuation. A missing cached outcome only costs a
    // duplicate resume its cached answer.
    route.logger.error(
      { suspensionId: id, err },
      "Could not cache the terminal outcome of a completed revival. The work finished; a duplicate resume will be told the outcome is unrecorded.",
    );
  }

  return {
    status: "resumed",
    suspensionId: id,
    routeId: suspension.routeId,
    outcome,
  };
}

/**
 * Refuse a resume whose continuation no longer matches, exactly once.
 *
 * The transition is what bounds the notification. A continuation mismatch
 * is permanent for that record (the live hash is recomputed on every
 * attempt and will not match again), so without a latch every replay of a
 * still-valid token would re-drive the suspended route's error channel,
 * approver notifications included, for as long as the token lives. That is
 * the amplifier the expiry path is hardened against and the one the
 * RC5049 narrowing removed; this path had neither guard.
 *
 * `denied` is the honest state: the suspension can no longer be honoured,
 * and the route has been told to re-ask rather than to wait. The cost is
 * that rolling the deploy back no longer rescues this exchange, which is
 * consistent with the design's answer to a changed continuation (re-ask
 * with a fresh suspension) rather than a new limitation.
 *
 * @internal
 */
async function refuseContinuation(
  context: CraftContext,
  store: SuspensionStore,
  route: Route,
  suspension: Suspension,
  reason: string,
  message: string,
): Promise<ResumeAcknowledgment> {
  const error = rcError("RC5048", undefined, { message });
  // Same claim-deliver-finalize shape as expiry, for the same crash: a
  // denial finalized before its re-ask was delivered would strand the
  // approver at a dead link with no signal.
  const cas = await store.claimExpiry(suspension.id, new Date());
  if (!cas.won) {
    // Whoever won the transition says what happened, as on the expiry and
    // duplicate paths. A replay that lost to the denial has to read back the
    // stored `deniedReason` rather than this request's RC5048, and an answer
    // that won `markResumed` on the way in was accepted: reporting a changed
    // continuation for it would describe work that is running as refused.
    if (cas.suspension) return settled(cas.suspension);
    throw error;
  }
  await reask(context, route, suspension, error);
  await store.markDenied(suspension.id, reason);
  throw error;
}

/**
 * Read an identity header straight off the stored exchange.
 *
 * Event payloads carry the PARKED exchange's identity, not the ingress
 * route's, because the events describe the suspended exchange's lifecycle:
 * a consumer correlating `:suspended` with `:resumed` has to see the same
 * ids on both. Rehydrating a whole exchange just to read two headers would
 * be wasteful, and would fail for a record the deserializer refuses, on a
 * path whose whole job is to report a failure.
 *
 * @internal
 */
function headerOf(suspension: Suspension, key: string): string {
  const value = suspension.exchange.headers[key];
  return typeof value === "string" ? value : suspension.id;
}

/** @internal */
function exchangeIdOf(suspension: Suspension): string {
  return headerOf(suspension, HeadersKeys.ID);
}

/** @internal */
function correlationIdOf(suspension: Suspension): string {
  return headerOf(suspension, HeadersKeys.CORRELATION_ID);
}

/**
 * Answer a resume that arrived after the suspension already settled.
 *
 * A duplicate answer is the normal case here (an approver double-clicks, a
 * webhook is redelivered), and it must not re-run the continuation: the
 * cached terminal outcome is exactly what the first resume produced. The
 * other settled states are terminal failures the caller has to see.
 *
 * @internal
 */
function settled(suspension: Suspension): ResumeAcknowledgment {
  if (suspension.status === "resumed") {
    return {
      status: "duplicate",
      suspensionId: suspension.id,
      routeId: suspension.routeId,
      // A resumed suspension whose terminal outcome is missing means
      // execution two is still running (or the process died mid-run). Report
      // it as such rather than inventing a completion.
      outcome: suspension.terminal ?? {
        status: "failed",
        error: {
          message:
            "The first resume of this suspension has not recorded a terminal outcome yet.",
        },
        at: suspension.resumedAt ?? suspension.suspendedAt,
      },
    };
  }

  // No re-ask here, deliberately. The record is ALREADY settled or claimed,
  // so whoever moved it there (the sweeper, a cancellation, an earlier
  // resume that lost no race) owns the notification. Re-entering the
  // route's error channel per arriving replay would notify the approver
  // once per request rather than once per event, from a token anyone who
  // saw the original link still holds.
  //
  // An `expiring` claim is disambiguated by WHEN it was taken, not by the
  // clock now: an expiry claim is only ever taken once the deadline has
  // passed, and a denial claim only while it has not, so the claim
  // timestamp against the deadline says which flow owns the record. The
  // current time would flip a denial claim into an "expiry" merely because
  // its slow re-ask crossed the deadline while running.
  const claimRef = suspension.claimedAt ?? new Date();
  const expiryClaim =
    suspension.expiresAt !== undefined &&
    claimRef.getTime() >= suspension.expiresAt.getTime();
  throw suspension.status === "expired" ||
    (suspension.status === "expiring" && expiryClaim)
    ? rcError("RC5047", undefined, {
        message: `Suspension "${suspension.id}" expired before an answer arrived.`,
      })
    : rcError("RC5050", undefined, {
        message: `Suspension "${suspension.id}" was denied${suspension.deniedReason ? `: ${suspension.deniedReason}` : ""}.`,
      });
}

/** A suspension the store gave a deadline, which is the only kind that expires. */
export type ExpiringSuspension = Suspension & { expiresAt: Date };

/**
 * Retire an overdue suspension and tell its route, exactly once.
 *
 * Shared by the two things that can discover an expiry: a late answer
 * arriving at `.resume()`, and the sweeper. Both must reach the same
 * outcome, and only one of them may notify, which is what the
 * compare-and-swap decides. The loser gets the post-attempt record back
 * and reports what the winner did rather than its own view, so an answer
 * that won `markResumed` on the deadline is reported as resumed, not
 * expired.
 *
 * Returns rather than throws: the sweeper is not answering anyone, so an
 * expiry is not exceptional to it. The caller decides whether the error is
 * a return value or a throw.
 *
 * @internal
 */
export async function expireSuspension(
  context: CraftContext,
  store: SuspensionStore,
  route: Route,
  suspension: ExpiringSuspension,
): Promise<{ cas: SuspensionCasResult; error: Error }> {
  const deadline = suspension.expiresAt;
  const error = rcError("RC5047", undefined, {
    message: `Suspension "${suspension.id}" expired at ${deadline.toISOString()}.`,
  });
  // Claim, deliver, finalize. The claim is what makes a crash mid-delivery
  // healable: a record left `expiring` is released back to `suspended` once
  // its lease elapses and the next sweep redelivers it, where a record
  // finalized before delivery would be terminal with its approver never
  // told. The cost is that a crash AFTER delivery but before finalize
  // redelivers once; notification is at-least-once by design.
  const cas = await store.claimExpiry(suspension.id, new Date());
  if (!cas.won) return { cas, error };

  context.emit("route:exchange:expired", {
    routeId: suspension.routeId,
    exchangeId: exchangeIdOf(suspension),
    correlationId: correlationIdOf(suspension),
    suspensionId: suspension.id,
    expiresAt: deadline,
  });
  await reask(context, route, suspension, error);
  const finalized = await store.markExpired(suspension.id);
  if (!finalized.won) {
    // Single-node, so the only way to lose a finalize is a lease release
    // racing an extremely slow delivery. The next sweep pass redelivers,
    // which is the at-least-once trade already made above.
    context.logger.warn(
      { suspensionId: suspension.id },
      "An expiry claim was released before its delivery finalized, so the next sweep will redeliver it.",
    );
  }
  return { cas, error };
}

/**
 * Re-enter the suspended route's error channel with a revival failure, then
 * hand the error back so the ingress route sees it too.
 *
 * Both halves matter. The ingress caller gets a typed error because it
 * asked a question and deserves an answer. The suspended route gets the
 * same error through its own `.error()` handler because it is the only
 * place that can do something useful about it: notify the approver, escalate,
 * or re-ask with a fresh suspension. Without that, a late answer strands the
 * approver at a dead link.
 *
 * The rehydrated exchange is what the handler receives, so it sees the
 * payload the approval was about. Its principal comes back marked restored
 * (see `auth/restored.ts`), so an `authorize()` in a re-ask path refuses it
 * rather than trusting a shape read off disk.
 *
 * @internal
 */
async function reask(
  context: CraftContext,
  route: Route,
  suspension: Suspension,
  error: Error,
): Promise<Error> {
  try {
    await route.enterErrorChannel(
      rehydrate(context, route, suspension),
      error,
      "resume",
    );
  } catch (channelError) {
    // The re-ask path is best effort by construction: the caller is already
    // being handed `error`, and replacing it with whatever the route's own
    // error handler did would hide the actual revival failure.
    context.logger.error(
      {
        err: channelError,
        routeId: suspension.routeId,
        suspensionId: suspension.id,
      },
      "Suspended route's error channel failed while handling a revival failure",
    );
  }
  return error;
}

/**
 * Rebuild the parked exchange on this process, with the answer in place.
 *
 * The resume state goes on headers rather than being handed to the steps
 * some other way, because it has to survive a SECOND suspend of the same
 * exchange, and headers are the exchange's state (see
 * `.standards/exchange-state-model.md`). It is stored LIVE (a `Date` in the
 * answer stays a `Date`); the serialization rules apply to it at the next
 * park, the same as to every other header.
 *
 * @internal
 */
function rehydrate(
  context: CraftContext,
  route: Route,
  suspension: Suspension,
  resumption?: {
    result: unknown;
    resumedAt: Date;
    resumedBy?: PrincipalRef;
  },
): Exchange {
  const base = deserializeExchange(context, suspension.exchange);
  const exchange = DefaultExchange.rewrap(base, {
    headers: {
      ...base.headers,
      [HeadersKeys.ROUTE_ID]: suspension.routeId,
      // Carried onto execution two so a continuation that parks AGAIN
      // inherits the channel it was answered on. A re-park that named no
      // key would otherwise land where no door serves it, and its approver
      // would hold a valid-looking link every ingress refuses.
      ...(suspension.key !== undefined
        ? { [SuspensionHeaders.KEY]: suspension.key }
        : {}),
      ...(resumption
        ? {
            [SuspensionHeaders.RESULT]: resumption.result,
            [SuspensionHeaders.RESUMED_AT]: resumption.resumedAt,
            ...(resumption.resumedBy
              ? { [SuspensionHeaders.RESUMED_BY]: resumption.resumedBy }
              : {}),
          }
        : {}),
    },
  });
  setExchangeRoute(exchange, route);
  return exchange;
}

/**
 * Run the continuation and reduce it to the outcome the store caches.
 *
 * @internal
 */
async function runContinuation(
  route: Route,
  exchange: Exchange,
  continuation: ReadonlyArray<Step<Adapter>>,
  at: Date,
): Promise<SerializedOutcome> {
  const result = await route.runContinuation(exchange, continuation);
  if (result.suspended) {
    // The continuation reached another `.suspend()`. Recording a body here
    // would cache the SECOND suspension's acknowledgment, token included,
    // and hand it back to whoever answered the first one: in a two-stage
    // approval that is approver A receiving approver B's capability.
    return { status: "suspended", at };
  }
  if (result.dropped) {
    return { status: "dropped", reason: "dropped by the route", at };
  }
  if (result.failed) {
    const error = result.error as
      | { rc?: string; meta?: { message?: string }; message?: string }
      | undefined;
    return {
      status: "failed",
      error: {
        ...(typeof error?.rc === "string" ? { rc: error.rc } : {}),
        message:
          error?.meta?.message ?? error?.message ?? "the continuation failed",
      },
      at,
    };
  }
  // Only the terminal BODY is cached, and only if it is storable. A route
  // whose output is not JSON data still resumes correctly; a duplicate
  // resume then learns that it completed without being handed a body it
  // could not have round-tripped anyway.
  let body: unknown;
  try {
    body = encodePersistable(result.exchange.body, "terminal body");
  } catch {
    body = undefined;
  }
  return {
    status: "completed",
    ...(body !== undefined ? { body } : {}),
    at,
  };
}

/**
 * Find the suspending step and its site by the address on the record.
 *
 * A static `.suspend()` site can be read back off the route, so both its
 * live schema (when it declared one) and its live `authorize()` predicate
 * come back here: the schema gates answer validation (`RC5049`) and the
 * predicate is what band 3 runs. A re-entrant site carries neither, because
 * both were raised inside the step's own code and cannot be read back, so
 * its answer skips validation and its hash comparison uses the stored
 * descriptor. The step itself heads the hashed tail there instead.
 *
 * @internal
 */
function findSite(
  route: Route,
  suspension: Suspension,
):
  | {
      step: Step<Adapter>;
      site: SuspendSite;
      schema?: StandardSchemaV1;
      authorize?: ResumeAuthorizer;
    }
  | undefined {
  for (const step of route.definition.suspendSteps ?? []) {
    if (step.site?.position === suspension.position) {
      return {
        step,
        site: step.site,
        ...(step.schema !== undefined ? { schema: step.schema } : {}),
        ...(step.authorize !== undefined ? { authorize: step.authorize } : {}),
      };
    }
  }
  for (const host of route.definition.reentrantSuspendSteps ?? []) {
    if (host.suspendSite?.position === suspension.position) {
      return { step: host, site: host.suspendSite };
    }
  }
  return undefined;
}
