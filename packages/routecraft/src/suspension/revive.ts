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
import { continuationTailHash, describeSchema } from "./hash.ts";
import {
  type ResumeAuthorizer,
  checkCallBinding,
  parkedPrincipal,
  recordView,
  runAuthorizer,
} from "./authorize.ts";
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
 * and the payload to revive it with.
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
  /** The submitted payload, validated against the suspending step's `schema`. */
  result: unknown;
  /**
   * Who resumed it. Defaults to the ingress exchange's own principal, which
   * is the value worth recording: it was verified live on the route that
   * accepted the submission, unlike anything read back out of the store.
   * Set it explicitly only when the resuming principal is not the caller
   * (an ops tool resuming on someone's behalf).
   */
  resumedBy?: PrincipalRef;
}

/**
 * What the resume DOOR contributes, as opposed to what its mapper produced.
 *
 * Kept separate from {@link ResumeRequest} deliberately. The mapper is user
 * code shaping a transport payload, and a payload is exactly what an
 * attacker controls; letting it name the resuming principal or supply the
 * hook would let the untrusted half of an ingress choose what the trusted
 * half checks.
 *
 * @internal
 */
export interface ResumeDoor {
  /** The door's own authorization policy, when it declares one. */
  readonly authorize?: ResumeAuthorizer;
  /** The principal this ingress route verified live, if any. */
  readonly principal?: Principal;
  /** The ingress step's abort signal, which is what bounds an async hook. */
  readonly signal?: AbortSignal;
}

/**
 * What `.resume()` puts in the ingress route's body once revival settles.
 *
 * The ingress route continues after this, which is what lets it reply on
 * the caller's own channel ("thanks, the payout is on its way"). It therefore
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
 * The order of checks is the security contract, and it is ordered rather
 * than merely "pre-claim" because the window before the claim is NOT inert:
 * the deadline arm and the continuation arm each take a compare-and-swap
 * that settles the record and drives the suspended route's error channel,
 * which in practice sends the approver a message. A credential that has no
 * business here must be refused before it can reach either, or the wrong
 * holder can burn the rightful principal's claim and drive an outbound
 * notification with it.
 *
 * 1. The token verifies (`RC5041`) and the suspension exists (`RC5046`).
 * 2. The credential was minted for THIS call (`RC5055`), read from the
 *    record alone.
 * 3. The route's own `authorize` hook accepts the principal (`RC5056`), if
 *    it declared one. This is where an application's policy runs; the
 *    framework has none of its own.
 * 4. Only now the lifecycle: a duplicate gets the cached terminal outcome
 *    rather than a second execution, an expired record `RC5047`, a denied
 *    one `RC5050`. Steps 2 and 3 sit above this deliberately, so a refused
 *    caller learns nothing about the record's state.
 * 5. Its route is still registered and still leads to the same continuation
 *    (`RC5048`), so an approval cannot authorize steps that were edited
 *    under it. The hash is COMPARED non-destructively; only a mismatch
 *    reached by a caller steps 2 and 3 already accepted may settle it.
 * 6. The payload satisfies the suspending step's `schema` (`RC5049`, in
 *    the ingress route only), and the compare-and-swap out of `suspended`
 *    is won here and not by a concurrent resume or the expiry sweeper.
 *
 * Every failure throws in the ingress route. A failure that leaves the
 * approver STRANDED (an expiry, a changed continuation, a denied
 * suspension) additionally re-enters the suspended route's error channel,
 * because only that route can notify and re-ask. A rejected payload
 * (`RC5049`) deliberately does not: it is a per-request input error rather
 * than a change in the world, the suspension stays resumable, and routing
 * it through the suspended route would let any token holder drive that
 * route's re-ask path with junk. The two authorization refusals are the
 * same: they leave the record exactly as they found it.
 *
 * @param context - The context reviving the exchange (the ingress route's)
 * @param request - Token plus submitted payload, as the mapper produced them
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

  // Record and credential only: no route lookup, no transition, no
  // disclosure. Placed above the settled return deliberately, so a holder
  // whose credential does not belong here cannot use the response to learn
  // the record's lifecycle state.
  checkCallBinding(suspension, sub);

  // The application's own policy, and the last thing that runs before the
  // record's lifecycle becomes observable. It reads the record and the two
  // principals; it cannot transition anything, and a refusal leaves the
  // record exactly as it was found.
  if (door.authorize) {
    await runAuthorizer(
      door.authorize,
      {
        principal: door.principal,
        parked: parkedPrincipal(suspension),
        payload: request.result,
        record: recordView(suspension),
      },
      context.logger,
      door.signal,
    );
  }

  if (suspension.status !== "suspended") {
    return settled(suspension);
  }

  const route = context.getRouteById(suspension.routeId);
  if (!route) {
    throw rcError("RC5046", undefined, {
      message: `Suspension "${id}" belongs to route "${suspension.routeId}", which is not registered in this context. Resume must run in a context that has the suspended route.`,
    });
  }

  // Checked here as well as by the sweeper: a resume can arrive between the
  // deadline and the sweep that marks it, and resuming into a window the
  // route already declared closed is exactly what `ttl` rules out. Reached
  // after the hook has settled on purpose, so a hook that overran the
  // deadline reports RC5047 rather than reviving into a closed window.
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
      // win `markResumed` right on the deadline, and that resume WAS
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
  // from the hashed tail by design, which makes this descriptor the ONLY
  // representation of that step in the digest.
  //
  // For a re-entrant site the stored descriptor is all there is: the live
  // schema was raised inside the step's own code and cannot be read back
  // off the route, so the schema arm IS inert there. The step itself heads
  // the hashed tail instead, so its definition is covered; the schema is
  // the same residue class as the behaviour of what the tail calls.
  //
  // `meta` is deliberately NOT in the digest. It lives only on the record,
  // so there is no live copy for it to drift from: a parker that snapshots
  // its policy into `meta` gets policy-travels-with-the-park by
  // construction rather than by a tamper check.
  //
  // The branch keys on RE-ENTRANCY, not on whether a live schema was found.
  // A static site always describes what it declares TODAY, absence included:
  // keying on `site.schema` would make a removed schema fall through to the
  // stored descriptor, compare it against itself, and accept the parked
  // payload unvalidated with no re-ask, which is the exact edit the absent
  // sentinel exists to catch.
  const current = continuationTailHash(
    site.site.continuation,
    site.site.reentrant ? suspension.schema : describeSchema(site.schema),
  );
  if (current !== suspension.continuationHash) {
    // Reached only by a caller the credential binding and the door's hook
    // both accepted. `refuseContinuation` denies the record and drives the
    // approver notification, so a refused holder must never get here: they
    // would burn the rightful principal's claim and send the message
    // themselves.
    return await refuseContinuation(
      context,
      runtime.store,
      route,
      suspension,
      "continuation changed",
      `Route "${suspension.routeId}" changed after position ${suspension.position} while this exchange was parked, so the stored payload no longer authorizes what would run.`,
    );
  }

  // Validation runs against the LIVE schema read off the route: a Standard
  // Schema is an object with a validate function and cannot be persisted.
  // Reaching here means the hash check above already confirmed that live
  // schema is the one the approval was taken against.
  //
  // A re-entrant site has no live schema to read back (it was raised inside
  // the step's own code), so the check is skipped THERE AND ONLY THERE: the
  // raw payload is handed to the re-entering step as its suspended call's
  // result, and the step is the validator. A token holder can therefore
  // resume a re-entrant suspension with any JSON; the consuming step (the
  // agent tier's model loop is the shipped case) must treat it as untrusted
  // input, which a tool result already is.
  let payload: unknown = request.result;
  if (site.schema) {
    const result = await validateAgainst(site.schema, request.result);
    if (!result.ok) {
      // Ingress only, deliberately: unlike an expiry or a changed
      // continuation, a malformed payload is not a change in the world the
      // suspended route has to react to. It is a per-request input error, and
      // re-entering the suspended route's error channel for it would hand any
      // token holder a lever to drive that route's re-ask path (approver
      // notifications included) with junk. The suspension is left resumable,
      // so the caller simply corrects the payload; shaping a reply to a bad
      // payload is the ingress route's own `.error()` handler's job.
      throw rcError("RC5049", result.message, {
        message: `The payload for suspension "${id}" does not satisfy its declared schema: ${result.message}`,
      });
    }
    payload = result.value;
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
  // above ran before validating the payload, and validation is a user
  // schema: it can await. Without this, a payload that arrived in time but
  // validated slowly would run the continuation past the window its route
  // declared, which is the one thing `ttl` promises it will not do.
  if (
    suspension.expiresAt !== undefined &&
    suspension.expiresAt.getTime() <= Date.now()
  ) {
    const expiry = rcError("RC5047", undefined, {
      message: `Suspension "${id}" expired at ${suspension.expiresAt.toISOString()} while its payload was being validated.`,
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
  // forever, and every later resume would be told the first resume has not
  // recorded an outcome yet. Recording the failure keeps a replay
  // idempotent, which is the contract a claimed suspension owes.
  let outcome: SerializedOutcome;
  try {
    const exchange = rehydrate(context, route, suspension, {
      result: payload,
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
    // Throwing here would tell the caller the work failed after it
    // succeeded, and the boot scan would later count the record as a
    // half-run continuation. A missing cached outcome only costs a
    // duplicate resume its cached reply.
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
 * consistent with how the design treats a changed continuation (re-ask
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
    // stored `deniedReason` rather than this request's RC5048, and a resume
    // that won `markResumed` on the way in was accepted: reporting a changed
    // continuation for it would describe work that is running as refused.
    if (cas.suspension) return settled(cas.suspension);
    throw error;
  }
  await reask(context, route, suspension, error);
  const finalized = await store.markDenied(suspension.id, reason);
  if (!finalized.won) {
    // The claim was released before the denial landed, which puts the record
    // back to suspended with a hash that can never match again. Every replay
    // of a still-valid token now re-wins this path and re-drives the re-ask,
    // which is the outbound amplifier the latch exists to remove.
    context.logger.warn(
      { suspensionId: suspension.id, routeId: suspension.routeId, reason },
      "A continuation refusal was released before its denial finalized, so the record is resumable again and a replay will re-drive the re-ask",
    );
  }
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
 * Reply to a resume that arrived after the suspension already settled.
 *
 * A duplicate resume is the normal case here (an approver double-clicks, a
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
        message: `Suspension "${suspension.id}" expired before a resume arrived.`,
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
 * Shared by the two things that can discover an expiry: a late resume
 * arriving at `.resume()`, and the sweeper. Both must reach the same
 * outcome, and only one of them may notify, which is what the
 * compare-and-swap decides. The loser gets the post-attempt record back
 * and reports what the winner did rather than its own view, so a resume
 * that won `markResumed` on the deadline is reported as resumed, not
 * expired.
 *
 * Returns rather than throws: the sweeper has no caller to reply to, so an
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
 * made a request and deserves a reply. The suspended route gets the same
 * error through its own `.error()` handler because it is the only place
 * that can do something useful about it: notify, escalate, or re-ask with a
 * fresh suspension. Without that, a late resume strands its sender at a
 * dead link.
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
 * Rebuild the parked exchange on this process, with the payload in place.
 *
 * The resume state goes on headers rather than being handed to the steps
 * some other way, because it has to survive a SECOND suspend of the same
 * exchange, and headers are the exchange's state (see
 * `.standards/exchange-state-model.md`). It is stored LIVE (a `Date` in the
 * payload stays a `Date`); the serialization rules apply to it at the next
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
    // and hand it back to whoever resumed the first one: in a two-stage
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
 * A static `.suspend()` site can be read back off the route, so its live
 * schema comes back here when it declared one, gating payload validation
 * (`RC5049`). A re-entrant site carries none, because the schema was raised
 * inside the step's own code and cannot be read back, so its payload skips
 * validation and its hash comparison uses the stored descriptor. The step
 * itself heads the hashed tail there instead.
 *
 * @internal
 */
function findSite(
  route: Route,
  suspension: Suspension,
):
  | { step: Step<Adapter>; site: SuspendSite; schema?: StandardSchemaV1 }
  | undefined {
  for (const step of route.definition.suspendSteps ?? []) {
    if (step.site?.position === suspension.position) {
      return {
        step,
        site: step.site,
        ...(step.schema !== undefined ? { schema: step.schema } : {}),
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
