import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CraftContext } from "../context.ts";
import { validateAgainst } from "../pipeline/validation.ts";
import { rcError } from "../error.ts";
import {
  type Exchange,
  DefaultExchange,
  HeadersKeys,
  setExchangeRoute,
} from "../exchange.ts";
import type { Route } from "../route.ts";
import type { Adapter, Step } from "../types.ts";
import { continuationHash, describeExpect } from "./hash.ts";
import { SuspensionHeaders } from "./exchange-state.ts";
import { SUSPENSION_RUNTIME } from "./runtime-key.ts";
import { deserializeExchange, encodePersistable } from "./serialize.ts";
import type { SuspendSite } from "./sites.ts";
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
  /** The candidate answer, validated against the suspending step's `expect`. */
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
 * The order of checks is the security contract, and each one refuses before
 * the continuation can run:
 *
 * 1. The token verifies (`RC5041`), so only this deployment could have
 *    minted it.
 * 2. The suspension exists (`RC5046`).
 * 3. It is still resumable: a duplicate gets the cached terminal outcome
 *    rather than a second execution, an expired one `RC5047`, a denied one
 *    `RC5050`.
 * 4. Its route is still registered and still leads to the same
 *    continuation (`RC5048`), so an approval cannot authorize steps that
 *    were edited under it.
 * 5. The answer satisfies the suspending step's `expect` (`RC5049`, in
 *    the ingress route only).
 * 6. The compare-and-swap out of `suspended` is won here and not by a
 *    concurrent resume or the expiry sweeper.
 *
 * Every failure throws in the ingress route. A failure that leaves the
 * approver STRANDED (an expiry, a changed continuation, a denied
 * suspension) additionally re-enters the suspended route's error channel,
 * because only that route can notify and re-ask. A rejected answer
 * (`RC5049`) deliberately does not: it is a per-request input error rather
 * than a change in the world, the suspension stays resumable, and routing
 * it through the suspended route would let any token holder drive that
 * route's re-ask path with junk.
 *
 * @param context - The context reviving the exchange (the ingress route's)
 * @param request - Token plus candidate answer
 * @returns The acknowledgment for the ingress route's body
 *
 * @internal
 */
export async function reviveSuspension(
  context: CraftContext,
  request: ResumeRequest,
): Promise<ResumeAcknowledgment> {
  const runtime = context.getStore(SUSPENSION_RUNTIME);
  if (!runtime) {
    throw rcError("RC5052", undefined, {
      message:
        "Cannot resume: this context has no suspension runtime, so no token it was handed can be verified. Add suspension: {} to defineConfig.",
    });
  }

  const { id } = runtime.signer.verify(request.token);
  const suspension = await runtime.store.get(id);
  if (!suspension) {
    throw rcError("RC5046", undefined, {
      message: `No suspension is stored under id "${id}".`,
    });
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

  // `describeExpect(site.expect)`, never `suspension.expect`: the stored
  // descriptor is the one that was folded into `suspension.continuationHash`
  // at park time, so comparing it against itself is inert and a widened
  // `expect` would resume into a contract its approver never saw. The
  // suspending step's own definition is excluded from the hashed tail by
  // design, which makes this descriptor the ONLY representation of that step
  // in the digest.
  const current = continuationHash(
    [site.step, ...site.site.continuation],
    0,
    describeExpect(site.expect),
  );
  if (current !== suspension.continuationHash) {
    return await refuseContinuation(
      context,
      runtime.store,
      route,
      suspension,
      "continuation changed",
      `Route "${suspension.routeId}" changed after position ${suspension.position} while this exchange was parked, so the stored answer no longer authorizes what would run.`,
    );
  }

  // Validation runs against the LIVE schema read off the route: a Standard
  // Schema is an object with a validate function and cannot be persisted.
  // Reaching here means the hash check above already confirmed that live
  // schema is the one the approval was taken against.
  const result = await validateAgainst(site.expect, request.result);
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
      message: `The answer for suspension "${id}" does not satisfy the expect schema: ${result.message}`,
    });
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
      result: result.value,
      resumedAt,
      ...(request.resumedBy ? { resumedBy: request.resumedBy } : {}),
    });

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
  // An `expiring` claim is disambiguated by the deadline it shares the
  // record with: an expiry claim is only ever taken on an overdue record,
  // so a claim on a record whose deadline has not passed (or that has
  // none) can only be a denial mid-delivery, and reporting IT as expired
  // would tell the answerer their approval timed out when the route
  // changed under it.
  const overdue =
    suspension.expiresAt !== undefined &&
    suspension.expiresAt.getTime() <= Date.now();
  throw suspension.status === "expired" ||
    (suspension.status === "expiring" && overdue)
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
 * @internal
 */
function findSite(
  route: Route,
  suspension: Suspension,
):
  | { step: Step<Adapter>; site: SuspendSite; expect: StandardSchemaV1 }
  | undefined {
  for (const step of route.definition.suspendSteps ?? []) {
    if (step.site?.position === suspension.position) {
      return { step, site: step.site, expect: step.expect };
    }
  }
  return undefined;
}
