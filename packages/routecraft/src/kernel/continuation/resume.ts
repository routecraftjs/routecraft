import { authorityOf } from "../authority.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CraftContext } from "../../context.ts";
import { validateAgainst } from "../../pipeline/validation.ts";
import { rcError } from "../../error.ts";
import {
  type Exchange,
  DefaultExchange,
  HeadersKeys,
  setExchangeRoute,
  setResumeStepState,
} from "../../exchange.ts";
import type { Route } from "../../route.ts";
import type { Adapter, Step } from "../../types.ts";
import { continuationTailHash, describeSchema } from "./hash.ts";
import {
  type ResumeAuthorizer,
  type ResumeElevator,
  checkCallBinding,
  deferredPrincipal,
  recordView,
  runAuthorizer,
  runElevator,
} from "./door.ts";
import { DeferralHeaders } from "./exchange-state.ts";
import { requireContinuations } from "./port.ts";
import {
  decodePersistable,
  deserializeExchange,
  encodePersistable,
} from "./serialize.ts";
import type { DetachedKind } from "../../pipeline/chain-policy.ts";
import type { DeferSite } from "./sites.ts";
import type { ErrorHook } from "../hooks.ts";
import type { Principal } from "../../principal.ts";
import { resumable } from "./types.ts";
import type {
  ErrorPathRecord,
  DeferralSchema,
  PrincipalRef,
  SerializedOutcome,
  Deferral,
  DeferralCasResult,
  DeferralStore,
} from "./types.ts";

/**
 * What `.resume()`'s mapping function produces: which deferral to revive,
 * and the payload to revive it with.
 *
 * The split is the boundary between the two halves of a resume. The mapping
 * function owns SHAPE (find the token in a mail reply, lift an approval out
 * of a chat webhook), because only the ingress route knows what its
 * transport looks like. Revival owns VALIDATION, because only the
 * deferral knows the schema the deferring step declared.
 */
export interface ResumeRequest {
  /** The signed token minted when the exchange deferred. */
  token: string;
  /** The submitted payload, validated against the deferring step's `schema`. */
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
  /**
   * The door's re-mint of the parked principal, when it declares one.
   *
   * On the trusted half with `authorize`, and for the same reason: this sets
   * the authority the continuation runs with, and the mapper is the
   * untrusted half of an ingress.
   */
  readonly elevate?: ResumeElevator;
  /** The principal this ingress route verified live, if any. */
  readonly principal?: Principal;
  /** The ingress step's abort signal, which is what bounds an async hook. */
  readonly signal?: AbortSignal;
  /**
   * The ingress route, so a door that dispatched it reads a rejected
   * payload (`RC5049`) as the submitter's input error, the way it reads
   * the route's own `.input()` refusal. Absent on a plugin-driven resume,
   * where no caller is waiting for an answer.
   */
  readonly routeId?: string;
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
   * deferral had already been resumed and this is the cached result of that
   * first revival. A duplicate re-runs nothing.
   */
  readonly status: "resumed" | "duplicate";
  readonly deferralId: string;
  /** Route the revived exchange belongs to. Not the ingress route. */
  readonly routeId: string;
  /**
   * How execution two ended.
   *
   * Named for the run rather than called an outcome, because
   * {@link Deferral.outcome} is how the DEFERRAL ended (resumed, expired,
   * denied) and the two would otherwise share a word while meaning
   * different things on adjacent types.
   */
  readonly continuation: SerializedOutcome;
}

/**
 * Revive a deferred exchange and run its continuation to completion.
 *
 * The order of checks is the security contract, and it is ordered rather
 * than merely "pre-claim" because the window before the claim is NOT inert:
 * the deadline arm and the continuation arm each take a compare-and-swap
 * that settles the record and drives the deferred route's error channel,
 * which in practice sends the approver a message. A credential that has no
 * business here must be refused before it can reach either, or the wrong
 * holder can burn the rightful principal's claim and drive an outbound
 * notification with it.
 *
 * 1. The token verifies (`RC5041`) and the deferral exists (`RC5046`).
 * 2. The credential was minted for THIS call (`RC5055`), read from the
 *    record alone.
 * 3. The route's own `authorize` hook accepts the principal (`RC5056`), if
 *    it declared one. This is where an application's policy runs; the
 *    framework has none of its own. The door's `elevate` hook runs here
 *    too (see `runElevator`), and its answer is held until the claim is
 *    won. Neither hook can transition the record.
 * 4. Only now the lifecycle: a duplicate gets the cached continuation result
 *    rather than a second execution, an expired record `RC5047`, a denied
 *    one `RC5050`. Steps 2 and 3 sit above this deliberately, so a refused
 *    caller learns nothing about the record's state. The deadline is read
 *    after the hooks settle, so a hook that overran it reports `RC5047`
 *    rather than reviving into a closed window, and it is checked here as
 *    well as by the sweeper because a resume can land between the deadline
 *    and the sweep. Retiring it is a compare-and-swap: winning it is the
 *    right to notify, so replaying a dead token cannot amplify outbound
 *    messages.
 * 5. Its route is still registered and still leads to the same continuation
 *    (`RC5048`), so an approval cannot authorize steps that were edited
 *    under it. The hash is COMPARED non-destructively; only a mismatch
 *    reached by a caller steps 2 and 3 already accepted may settle it.
 *    A static site folds its LIVE schema descriptor into the comparison,
 *    absence included, because the deferring step's definition is excluded
 *    from the hashed tail and the stored descriptor compared against itself
 *    would accept a widened or removed schema. Every other site raised its
 *    schema in code the route cannot be asked about, so the stored
 *    descriptor is all there is and the head of the tail covers the
 *    definition. `meta` is not hashed: it lives only on the record, so the
 *    policy it snapshots travels with the deferral by construction.
 * 6. The payload satisfies the deferring step's `schema` (`RC5049`, in
 *    the ingress route only), and the compare-and-swap out of `deferred`
 *    is won here and not by a concurrent resume or the expiry sweeper.
 *    A site with no live schema skips validation; the door's hooks or the
 *    continuation are the validator. The deadline is re-checked after the
 *    claim, because a user schema can await past it.
 *
 * Once `markResumed` is won, nothing else will ever settle the record, so
 * every later failure is recorded as the continuation result before it is
 * rethrown, and a failed store write never masks the original error. A
 * store failure after the continuation completed is logged, not thrown: the
 * work is done, and only a duplicate resume's cached reply is lost.
 *
 * Every failure throws in the ingress route. A failure that leaves the
 * approver STRANDED (an expiry, a changed continuation, a denied
 * deferral) additionally re-enters the deferred route's error channel,
 * because only that route can notify and re-ask. A rejected payload
 * (`RC5049`) deliberately does not: it is a per-request input error rather
 * than a change in the world, the deferral stays resumable, and routing
 * it through the deferred route would let any token holder drive that
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
export async function reviveDeferral(
  context: CraftContext,
  request: ResumeRequest,
  door: ResumeDoor = {},
): Promise<ResumeAcknowledgment> {
  const runtime = requireContinuations(
    context,
    "Cannot resume: no token this application was handed can be verified",
  );

  const { id, sub } = runtime.signer.verify(request.token);
  const deferral = await runtime.store.get(id);
  if (!deferral) {
    throw rcError("RC5046", undefined, {
      message: `No deferral is stored under id "${id}".`,
    });
  }

  // Above the settled return, so a foreign credential learns nothing of the lifecycle.
  checkCallBinding(deferral, sub);

  const authority = authorityOf(context);
  const hookInput = {
    principal: door.principal,
    deferred: deferredPrincipal(deferral, authority),
    payload: request.result,
    record: recordView(deferral),
  };
  if (door.authorize) {
    await runAuthorizer(door.authorize, hookInput, context.logger, door.signal);
  }

  // Held, and applied by `rehydrate()` only once the claim is won.
  const elevated = door.elevate
    ? await runElevator(
        door.elevate,
        hookInput,
        context.logger,
        deferral.errorPath?.refusedScopes,
        door.signal,
        authority,
      )
    : undefined;

  if (!resumable(deferral)) {
    return unresumable(deferral);
  }

  const route = context.getRouteById(deferral.routeId);
  if (!route) {
    throw rcError("RC5046", undefined, {
      message: `Deferral "${id}" belongs to route "${deferral.routeId}", which is not registered in this context. Resume must run in a context that has the deferred route.`,
    });
  }

  const deadline = deferral.expiresAt;
  if (deadline !== undefined && deadline.getTime() <= Date.now()) {
    const { cas, error } = await expireDeferral(context, runtime.store, route, {
      ...deferral,
      expiresAt: deadline,
    });
    if (!cas.won) {
      // A concurrent resume may have won on the deadline; whoever won says what happened.
      if (cas.deferral) return unresumable(cas.deferral);
    }
    throw error;
  }

  const site = findSite(context, route, deferral);
  if (!site) {
    return await refuseContinuation(
      context,
      runtime.store,
      route,
      deferral,
      "defer site removed",
      `Route "${deferral.routeId}" no longer has a .defer() at position ${deferral.position}.`,
    );
  }

  // Keyed on `schemaIsLive`, not `site.schema`: a removed schema must still hash as absent.
  const current = continuationTailHash(
    site.site.continuation,
    site.schemaIsLive ? describeSchema(site.schema) : deferral.schema,
    deferral.errorPath?.origin,
  );
  if (current !== deferral.continuationHash) {
    return await refuseContinuation(
      context,
      runtime.store,
      route,
      deferral,
      "continuation changed",
      `Route "${deferral.routeId}" changed after position ${deferral.position} while this exchange was deferred, so the stored payload no longer authorizes what would run.`,
    );
  }

  // A Standard Schema cannot be persisted, so only the live one can validate.
  let payload: unknown = request.result;
  if (site.schema) {
    const result = await validateAgainst(site.schema, request.result);
    if (!result.ok) {
      const cause = new Error(result.message);
      if (door.routeId !== undefined) {
        Object.assign(cause, {
          invalid: { in: "body", issues: result.issues, routeId: door.routeId },
        });
      }
      throw rcError("RC5049", cause, {
        message: `The payload for deferral "${id}" does not satisfy its declared schema: ${result.message}`,
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
    if (!cas.deferral) {
      throw rcError("RC5046", undefined, {
        message: `Deferral "${id}" disappeared while it was being resumed.`,
      });
    }
    return unresumable(cas.deferral);
  }

  if (
    deferral.expiresAt !== undefined &&
    deferral.expiresAt.getTime() <= Date.now()
  ) {
    const expiry = rcError("RC5047", undefined, {
      message: `Deferral "${id}" expired at ${deferral.expiresAt.toISOString()} while its payload was being validated.`,
    });
    // Winning `markResumed` means the sweeper cannot also report this, so
    // the notification is ours to send exactly once, store failure or not.
    try {
      await runtime.store.recordContinuation(id, {
        status: "failed",
        error: { rc: "RC5047", message: expiry.message },
        at: resumedAt,
      });
    } catch (unrecorded) {
      route.logger.error(
        { deferralId: id, err: unrecorded },
        "Could not record the expiry of a claimed deferral. The deferral stays resumed with no result and needs an operator.",
      );
    }
    context.emit("route:exchange:expired", {
      routeId: deferral.routeId,
      exchangeId: exchangeIdOf(deferral),
      correlationId: correlationIdOf(deferral),
      deferralId: id,
      expiresAt: deferral.expiresAt,
    });
    throw await reask(context, route, deferral, expiry);
  }

  let continuation: SerializedOutcome;
  try {
    const exchange = rehydrate(context, route, deferral, {
      result: payload,
      resumedAt,
      ...(request.resumedBy ? { resumedBy: request.resumedBy } : {}),
      ...(elevated ? { elevated } : {}),
    });
    // Internals, not headers: step state must not re-serialize into a second deferral.
    if (site.site.reentrant && deferral.stepState !== undefined) {
      setResumeStepState(exchange, decodePersistable(deferral.stepState));
    }

    context.emit("route:exchange:resumed", {
      routeId: deferral.routeId,
      exchangeId: exchange.id,
      correlationId: exchange.headers[HeadersKeys.CORRELATION_ID] as string,
      deferralId: id,
      position: deferral.position,
      ...(request.resumedBy ? { resumedBy: request.resumedBy } : {}),
    });

    continuation = await runContinuation(
      route,
      exchange,
      site.site.continuation,
      resumedAt,
      deferral.errorPath?.origin === "admission" ? "admission" : "resume",
    );
  } catch (error) {
    const failure = error as { rc?: string; message?: string } | undefined;
    try {
      await runtime.store.recordContinuation(id, {
        status: "failed",
        error: {
          ...(typeof failure?.rc === "string" ? { rc: failure.rc } : {}),
          message: failure?.message ?? "the revival failed",
        },
        at: resumedAt,
      });
    } catch (unrecorded) {
      route.logger.error(
        { deferralId: id, err: unrecorded },
        "Could not record the continuation result of a failed revival. The deferral stays resumed with no result and needs an operator.",
      );
    }
    throw error;
  }
  try {
    await runtime.store.recordContinuation(id, continuation);
  } catch (err) {
    route.logger.error(
      { deferralId: id, err },
      "Could not cache the continuation result of a completed revival. The work finished; a duplicate resume will be told the result is unrecorded.",
    );
  }

  return {
    status: "resumed",
    deferralId: id,
    routeId: deferral.routeId,
    continuation,
  };
}

/**
 * Refuse a resume whose continuation no longer matches, exactly once.
 *
 * The transition is what bounds the notification. A continuation mismatch
 * is permanent for that record (the live hash is recomputed on every
 * attempt and will not match again), so without a latch every replay of a
 * still-valid token would re-drive the deferred route's error channel,
 * approver notifications included, for as long as the token lives. That is
 * the amplifier the expiry path is hardened against.
 *
 * It follows the same claim, deliver, finalize shape as expiry, so a crash
 * cannot finalize a denial whose re-ask was never delivered. A caller that
 * loses the claim reports what the winner did: a replay reads back the
 * stored denial, and a resume that won `markResumed` was accepted. A claim
 * released before the denial lands leaves the record resumable with a hash
 * that never matches, which is logged because every replay would re-drive
 * the re-ask.
 *
 * `denied` is the honest state: the deferral can no longer be honoured,
 * and the route has been told to re-ask rather than to wait. Rolling the
 * deploy back therefore no longer rescues this exchange.
 *
 * @internal
 */
async function refuseContinuation(
  context: CraftContext,
  store: DeferralStore,
  route: Route,
  deferral: Deferral,
  reason: string,
  message: string,
): Promise<ResumeAcknowledgment> {
  const error = rcError("RC5048", undefined, { message });
  const cas = await store.claimExpiry(deferral.id, new Date());
  if (!cas.won) {
    if (cas.deferral) return unresumable(cas.deferral);
    throw error;
  }
  await reask(context, route, deferral, error);
  const finalized = await store.markDenied(deferral.id, reason);
  if (!finalized.won) {
    context.logger.warn(
      { deferralId: deferral.id, routeId: deferral.routeId, reason },
      "A continuation refusal was released before its denial finalized, so the record is resumable again and a replay will re-drive the re-ask",
    );
  }
  throw error;
}

/**
 * Read an identity header straight off the stored exchange.
 *
 * Event payloads carry the DEFERRED exchange's identity, not the ingress
 * route's, because the events describe the deferred exchange's lifecycle:
 * a consumer correlating `:deferred` with `:resumed` has to see the same
 * ids on both. Rehydrating a whole exchange just to read two headers would
 * be wasteful, and would fail for a record the deserializer refuses, on a
 * path whose whole job is to report a failure.
 *
 * @internal
 */
function headerOf(deferral: Deferral, key: string): string {
  const value = deferral.exchange.headers[key];
  return typeof value === "string" ? value : deferral.id;
}

/** @internal */
function exchangeIdOf(deferral: Deferral): string {
  return headerOf(deferral, HeadersKeys.ID);
}

/** @internal */
function correlationIdOf(deferral: Deferral): string {
  return headerOf(deferral, HeadersKeys.CORRELATION_ID);
}

/**
 * Reply to a resume that arrived at a deferral nothing can resume any more:
 * one that has settled, or one a delivery claim is outstanding on.
 *
 * A duplicate resume is the normal case here (an approver double-clicks, a
 * webhook is redelivered), and it must not re-run the continuation: the
 * cached continuation result is exactly what the first resume produced. The
 * other cases are failures the caller has to see.
 *
 * No re-ask is driven from here: whoever settled or claimed the record owns
 * the notification, and re-asking per replay would notify once per request
 * from a token anyone who saw the link still holds. An outstanding claim is
 * attributed by when it was taken, not by the clock now: an expiry claim is
 * only taken past the deadline and a denial claim only before it, so a slow
 * denial re-ask that crosses the deadline is still reported as a denial.
 *
 * @internal
 */
function unresumable(deferral: Deferral): ResumeAcknowledgment {
  if (deferral.outcome?.kind === "resumed") {
    return {
      status: "duplicate",
      deferralId: deferral.id,
      routeId: deferral.routeId,
      // Missing means execution two is still running or died mid-run.
      continuation: deferral.continuation ?? {
        status: "failed",
        error: {
          message:
            "The first resume of this deferral has not recorded a continuation result yet.",
        },
        at: deferral.outcome.at,
      },
    };
  }

  const claimRef = deferral.claimedAt ?? new Date();
  const expiryClaim =
    deferral.expiresAt !== undefined &&
    claimRef.getTime() >= deferral.expiresAt.getTime();
  throw deferral.outcome?.kind === "expired" ||
    (deferral.outcome === undefined && expiryClaim)
    ? rcError("RC5047", undefined, {
        message: `Deferral "${deferral.id}" expired before a resume arrived.`,
      })
    : rcError("RC5050", undefined, {
        message: `Deferral "${deferral.id}" was denied${deferral.outcome?.reason ? `: ${deferral.outcome.reason}` : ""}.`,
      });
}

/** A deferral the store gave a deadline, which is the only kind that expires. */
export type ExpiringDeferral = Deferral & { expiresAt: Date };

/**
 * Retire an overdue deferral and tell its route, exactly once.
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
 * Claim, deliver, finalize: a claim left outstanding by a crash is released
 * once its lease elapses and the next sweep redelivers it, where a record
 * settled before delivery would strand its approver. A crash after delivery
 * but before finalize redelivers once, so notification is at-least-once.
 *
 * @internal
 */
export async function expireDeferral(
  context: CraftContext,
  store: DeferralStore,
  route: Route,
  deferral: ExpiringDeferral,
): Promise<{ cas: DeferralCasResult; error: Error }> {
  const deadline = deferral.expiresAt;
  const error = rcError("RC5047", undefined, {
    message: `Deferral "${deferral.id}" expired at ${deadline.toISOString()}.`,
  });
  const cas = await store.claimExpiry(deferral.id, new Date());
  if (!cas.won) return { cas, error };

  context.emit("route:exchange:expired", {
    routeId: deferral.routeId,
    exchangeId: exchangeIdOf(deferral),
    correlationId: correlationIdOf(deferral),
    deferralId: deferral.id,
    expiresAt: deadline,
  });
  await reask(context, route, deferral, error);
  const finalized = await store.markExpired(deferral.id);
  if (!finalized.won) {
    // Single-node: only a lease release racing a very slow delivery loses this.
    context.logger.warn(
      { deferralId: deferral.id },
      "An expiry claim was released before its delivery finalized, so the next sweep will redeliver it.",
    );
  }
  return { cas, error };
}

/**
 * Re-enter the deferred route's error channel with a revival failure, then
 * hand the error back so the ingress route sees it too.
 *
 * Both halves matter. The ingress caller gets a typed error because it
 * made a request and deserves a reply. The deferred route gets the same
 * error through its own `.error()` handler because it is the only place
 * that can do something useful about it: notify, escalate, or re-ask with a
 * fresh deferral. Without that, a late resume strands its sender at a
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
  deferral: Deferral,
  error: Error,
): Promise<Error> {
  try {
    await route.enterErrorChannel(
      rehydrate(context, route, deferral),
      error,
      "resume",
    );
  } catch (channelError) {
    // Best effort: rethrowing would hide the actual revival failure.
    context.logger.error(
      {
        err: channelError,
        routeId: deferral.routeId,
        deferralId: deferral.id,
      },
      "Deferred route's error channel failed while handling a revival failure",
    );
  }
  return error;
}

/**
 * Rebuild the deferred exchange on this process, with the payload in place.
 *
 * The resume state goes on headers rather than being handed to the steps
 * some other way, because it has to survive a SECOND defer of the same
 * exchange, and headers are the exchange's state (see
 * `.standards/exchange-state-model.md`). It is stored LIVE (a `Date` in the
 * payload stays a `Date`); the serialization rules apply to it at the next
 * deferral, the same as to every other header.
 *
 * An elevated principal replaces the restored one only here, after the
 * claim, and by reference: `markAuthentic` freezes what it brands, and a
 * copy would drop the brand and refuse every elevated resume with `RC5023`.
 *
 * The refused-scopes header is rewritten on every resumption and deleted
 * when the record carries none, because a re-parked exchange re-serializes
 * the first park's header and a stale set would decide the loop-closing
 * rule for a park that recorded nothing.
 *
 * @internal
 */
function rehydrate(
  context: CraftContext,
  route: Route,
  deferral: Deferral,
  resumption?: {
    result: unknown;
    resumedAt: Date;
    resumedBy?: PrincipalRef;
    /**
     * What the door's `elevate` hook re-minted, already checked against the
     * identity rule. Replaces the restored principal, which is what lets the
     * continuation re-run `.authorize()` and pass.
     */
    elevated?: Principal;
  },
): Exchange {
  const base = deserializeExchange(context, deferral.exchange);
  const headers: Record<string, unknown> = {
    ...base.headers,
    [HeadersKeys.ROUTE_ID]: deferral.routeId,
    ...(resumption
      ? {
          [DeferralHeaders.RESULT]: resumption.result,
          [DeferralHeaders.RESUMED_AT]: resumption.resumedAt,
          ...(resumption.resumedBy
            ? { [DeferralHeaders.RESUMED_BY]: resumption.resumedBy }
            : {}),
        }
      : {}),
    // By reference: a copy drops the authenticity brand.
    ...(resumption?.elevated
      ? { [HeadersKeys.AUTH_PRINCIPAL]: resumption.elevated }
      : {}),
  };

  // Delete, not assign undefined: an undefined header still serializes as present.
  if (resumption) {
    const refused = deferral.errorPath?.refusedScopes;
    if (refused) headers[DeferralHeaders.REFUSED_SCOPES] = refused;
    else delete headers[DeferralHeaders.REFUSED_SCOPES];
  }

  const exchange = DefaultExchange.rewrap(base, { headers });
  setExchangeRoute(exchange, route);
  return exchange;
}

/**
 * Run the continuation and reduce it to the outcome the store caches.
 *
 * A continuation that reaches another `.defer()` caches no body: the body
 * is the second deferral's acknowledgment, and handing its token to whoever
 * resumed the first would give approver A approver B's capability. A
 * completed run caches its terminal body only when it is storable.
 *
 * @internal
 */
async function runContinuation(
  route: Route,
  exchange: Exchange,
  continuation: ReadonlyArray<Step<Adapter>>,
  at: Date,
  kind: DetachedKind,
): Promise<SerializedOutcome> {
  const result = await route.runContinuation(exchange, continuation, kind);
  if (result.deferred) {
    // The body here holds the next deferral's token; never cache it.
    return { status: "deferred", at };
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
 * Find the deferring step and its site by the address on the record.
 *
 * A static `.defer()` site can be read back off the route, so its live
 * schema comes back here when it declared one, gating payload validation
 * (`RC5049`). A re-entrant site carries none, because the schema was raised
 * inside the step's own code and cannot be read back, so its payload skips
 * validation and its hash comparison uses the stored descriptor. The step
 * itself heads the hashed tail there instead.
 *
 * An admission park is matched on the record's origin before anything else,
 * because it shares its position number with the first step's error-path
 * site. Any other error-path park is resolved only from the error-path
 * sites, and only for a record whose `errorPath` field says the error path
 * wrote it: every step carries an error-path site, a static `.defer()`
 * included, and an unguarded lookup would hand that step's own deferrals a
 * continuation that re-enters the defer. Lookups go by position because the
 * record carries a number; the walk is deterministic across processes.
 *
 * @internal
 */
function findSite(
  context: CraftContext,
  route: Route,
  deferral: Deferral,
):
  | {
      step?: Step<Adapter>;
      site: DeferSite;
      schema?: StandardSchemaV1;
      /**
       * The site's schema can be read back off the route TODAY: a static
       * `.defer()` declares it on the step, and an error-path park on the
       * `.error()` or the error hook that parked it. A re-entrant step raised
       * its schema inside its own body, which the route cannot be asked
       * about.
       */
      schemaIsLive?: boolean;
    }
  | undefined {
  if (deferral.errorPath) {
    const schema = liveErrorPathSchema(
      context,
      route,
      deferral.errorPath,
      deferral.schema,
    );
    const live = {
      schemaIsLive: true,
      ...(schema !== undefined ? { schema } : {}),
    };
    if (deferral.errorPath.origin === "admission") {
      const site = route.definition.admissionSite;
      return site ? { site, ...live } : undefined;
    }
    const errorPathSite = findErrorPathSite(route, deferral.position);
    if (errorPathSite) {
      return { site: errorPathSite.site, step: errorPathSite.step, ...live };
    }
    return undefined;
  }
  for (const step of route.definition.deferSteps ?? []) {
    if (step.site?.position === deferral.position) {
      return {
        step,
        site: step.site,
        schemaIsLive: true,
        ...(step.schema !== undefined ? { schema: step.schema } : {}),
      };
    }
  }
  for (const host of route.definition.reentrantDeferSteps ?? []) {
    if (host.deferSite?.position === deferral.position) {
      return { step: host, site: host.deferSite };
    }
  }
  return undefined;
}

/**
 * The schema an error-path park's resume payload is validated against, read
 * live off the handler that parked it: the route's `.error(handler, {
 * schema })` or the error hook the record names. A handler that declares
 * none, or that is gone, yields no schema, and the hash comparison that
 * follows decides whether that matches what was parked. A record written
 * before the handler was recorded falls back to the descriptor: the one
 * declared schema the stored hash identifies.
 */
function liveErrorPathSchema(
  context: CraftContext,
  route: Route,
  errorPath: ErrorPathRecord,
  stored: DeferralSchema,
): StandardSchemaV1 | undefined {
  if (errorPath.handler === "route") return route.definition.errorPathSchema;
  const hooks = context.errorHooks(route).decide;
  if (errorPath.handler !== undefined) {
    const parker = hooks.find((entry) => entry.id === errorPath.handler);
    return parker ? (parker.hook as ErrorHook).schema : undefined;
  }
  const declared = [
    route.definition.errorPathSchema,
    ...hooks.map((entry) => (entry.hook as ErrorHook).schema),
  ].filter((schema): schema is StandardSchemaV1 => schema !== undefined);
  if (stored.absent) return declared[0];
  return declared.find((schema) => describeSchema(schema).hash === stored.hash);
}

/**
 * The error-path site stamped at `position`, if the route still has one
 * there.
 *
 * Kept apart from the two defer lists because it answers a different
 * question: those say the route CAN defer here, this says where a park
 * WOULD land. A record written for an error-path park is resolved from it
 * alone, so editing the route into or out of a defer site cannot silently
 * move a parked exchange onto a different continuation; the hash comparison
 * that follows catches the rest.
 *
 * @internal
 */
function findErrorPathSite(
  route: Route,
  position: number,
): { step: Step<Adapter>; site: DeferSite } | undefined {
  for (const [step, resolved] of route.definition.errorPathSites ?? []) {
    if (resolved.kind === "site" && resolved.site.position === position) {
      return { step, site: resolved.site };
    }
  }
  return undefined;
}
