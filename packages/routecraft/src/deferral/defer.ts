import type { CraftContext } from "../context.ts";
import { rcError } from "../error.ts";
import {
  type Exchange,
  DefaultExchange,
  HeadersKeys,
  asideSequenceOf,
  markDeferred,
  noteAsideSequence,
} from "../exchange.ts";
import type { DeferRequest } from "./sites.ts";
import {
  actionFingerprint,
  continuationTailHash,
  describeSchema,
} from "./hash.ts";
import {
  DeferralHeaders,
  effectiveSequence,
  deferralIdOf,
} from "./exchange-state.ts";
import { DEFERRAL_RUNTIME } from "./runtime-key.ts";
import { serializeExchange } from "./serialize.ts";
import { type Deferred, createDeferred } from "./deferred.ts";
import type { NewDeferral } from "./types.ts";

/**
 * Deferring an exchange: everything that happens between a `.defer()`
 * producing its outcome and execution one answering.
 *
 * Ordering is deliberate and load-bearing. The exchange is serialized
 * FIRST, so the three serialization rules (no live values, no secrets, no
 * live-verified principal) fail the step before anything is written or
 * emitted; the store write comes next, so nothing is announced that cannot
 * be resumed; the mark and the event come last, once the deferral is
 * durable. A failure anywhere in here is an ordinary step failure and
 * reaches the route's `.error()` handler, because the exchange has not been
 * deferred and the route still owns it.
 *
 * @param context - Context whose deferral runtime holds the store and signer
 * @param exchange - The exchange as the defer step handed it over
 * @param request - What the defer step resolved: schema, meta, TTL, and site
 * @param routeId - Route the deferred exchange belongs to
 * @param abortSignal - The run's cancellation signal; an abort that lands
 *   during the store write denies the just-created deferral and fails the
 *   deferral with RC5054 before anything is announced
 * @returns The exchange execution one terminates with, its body replaced by
 *   the {@link Deferred} acknowledgment
 * @throws RC5052 when the context has no deferral runtime, RC5042 when
 *   the exchange cannot be persisted, RC5044 when the store write fails,
 *   RC5054 when the run was cancelled around the write
 *
 * @internal
 */
export async function deferExchange(
  context: CraftContext,
  exchange: Exchange,
  request: DeferRequest,
  routeId: string,
  abortSignal?: AbortSignal,
): Promise<Exchange> {
  const runtime = context.getStore(DEFERRAL_RUNTIME);
  if (!runtime) {
    throw rcError("RC5052", undefined, {
      message: `Route "${routeId}" reached a .defer() but this context has no deferral runtime. Add deferral: {} to defineConfig.`,
    });
  }

  // Per-defer `ttl` first, then the context default. A deferral with
  // no deadline at all is only reachable through `defaultTtl: "never"`,
  // because a deferral nobody resumes should eventually reach the route
  // that asked for it rather than sit in the store forever.
  const { id, deferring, record } = describeRecord(
    exchange,
    routeId,
    request,
    request.expiresInMs ?? runtime.defaultTtlMs,
  );
  const schema = record.schema;

  await runtime.store.create(record);

  // A cancellation that raced the store write and lost is resolved HERE,
  // after the durable write but before the mark and the announcement: the
  // just-created deferral is denied (claim-first, so a replayed token
  // reads RC5050 from the settled path) and the run fails with RC5054
  // without ever emitting `route:exchange:deferred`. Announcing first
  // would give one `exchange:started` two terminals, breaking the events
  // page's exactly-one lifecycle guarantee.
  if (abortSignal?.aborted) {
    const settled = await denyDeferred(
      context,
      deferring,
      id,
      routeId,
      "run cancelled",
      record.expiresAt,
    );
    // The RC5054 must land whatever the store does (the caller was told
    // the run failed), but it must not claim a denial that did not commit:
    // a store failure leaves the link live until the ttl retires it, and
    // the error-level log above is the operator's cue to settle it by hand.
    throw rcError("RC5054", abortSignal.reason, {
      message: settled
        ? `Route "${routeId}" deferred an exchange while its run was being cancelled; the deferral was denied so its resume link is dead.`
        : record.expiresAt
          ? `Route "${routeId}" deferred an exchange while its run was being cancelled, and denying the deferral failed; its resume link may stay live until the ttl retires it (deferral "${id}", see the error log).`
          : `Route "${routeId}" deferred an exchange while its run was being cancelled, and denying the deferral failed; its resume link has no expiry, so it stays live until an operator settles it (deferral "${id}", see the error log).`,
    });
  }

  // After the durable write, not before: this file's ordering promises that
  // nothing is announced that cannot be resumed, and a deferral that fails at
  // serialization or the store write must not leave an operator a warning
  // about a deferral that never existed.
  if (schema.degraded) {
    deferring.logger.warn(
      { deferralId: id, routeId, position: request.site.position },
      "The resume-payload schema advertises a JSON Schema extension that produced nothing, so this deferral cannot detect a changed schema: only the step tail is covered. Zod throws for a Date, a bigint or any transform.",
    );
  }

  const ack: Deferred = createDeferred({
    deferralId: id,
    token: runtime.signer.mint(id, new Date(), request.callBinding),
    ...(schema.jsonSchema !== undefined ? { schema: schema.jsonSchema } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
  });

  const deferred = DefaultExchange.rewrap(deferring, { body: ack });
  markDeferred(deferred);
  context.emit("route:exchange:deferred", {
    routeId,
    exchangeId: deferred.id,
    correlationId: deferred.headers[HeadersKeys.CORRELATION_ID] as string,
    deferralId: id,
    position: request.site.position,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
  });
  deferred.logger.info(
    { deferralId: id, routeId, position: request.site.position },
    "Exchange deferred",
  );

  if (request.notify) {
    await runNotify(context, deferred, request.notify, ack, {
      deferralId: id,
      routeId,
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
  }
  return deferred;
}

/**
 * Hand the acknowledgment to the directive's `notify` hook, and make sure a
 * notification that did not go out leaves no live link behind.
 *
 * LAST, after the store write and after `route:exchange:deferred`. The
 * ordering is the safety property: the site is resolved when the executor
 * receives the directive, so a handler that notified on its own would hand a
 * human a correctly signed token for a park `RC5051` can still refuse, and
 * nothing retires a dead link in an inbox. The reverse of `deferAside`'s
 * `announce`, which commits BEFORE its write for the opposite and equally
 * correct reason; see its JSDoc.
 *
 * Bounded like {@link runAuthorizer} bounds the resume `authorize` hook, and
 * for the same reason: this is awaited inside the executor with a network
 * call in it, so an unsettled hook holds the step, which holds `drain()`, and
 * its latency is caller-visible. An abort is treated exactly as a throw.
 *
 * The residue, stated because it is chosen rather than overlooked: a crash
 * between the write and the notification leaves a record nobody was told
 * about, which the record's ttl retires. The reverse order leaves a dead link
 * in a human's inbox, which nothing retires.
 *
 * @throws RC5067 when the hook throws or never settles, carrying the hook's
 *   own failure as the cause
 *
 * @internal
 */
async function runNotify(
  context: CraftContext,
  deferred: Exchange,
  notify: (ack: Deferred) => void | Promise<void>,
  ack: Deferred,
  ctx: {
    deferralId: string;
    routeId: string;
    expiresAt?: Date;
    signal?: AbortSignal;
  },
): Promise<void> {
  let onAbort: (() => void) | undefined;
  const { signal } = ctx;
  try {
    await Promise.race([
      (async () => notify(ack))(),
      new Promise<never>((_, reject) => {
        if (!signal) return;
        if (signal.aborted) {
          reject(NOTIFY_ABORTED);
          return;
        }
        onAbort = () => {
          reject(NOTIFY_ABORTED);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch (cause) {
    const aborted = cause === NOTIFY_ABORTED;
    // Claim-first, exactly as the cancellation path does: a replayed token
    // then reads RC5050 from the settled path rather than reviving work
    // whose caller was told it failed.
    const settled = await denyDeferred(
      context,
      deferred,
      ctx.deferralId,
      ctx.routeId,
      aborted ? "notification aborted" : "notification failed",
      ctx.expiresAt,
    );
    throw rcError("RC5067", aborted ? (signal?.reason ?? undefined) : cause, {
      message: settled
        ? `Route "${ctx.routeId}" parked an exchange but its notify hook ${aborted ? "did not settle before the run was cancelled" : "failed"}, so the deferral was denied and its resume link is dead.`
        : `Route "${ctx.routeId}" parked an exchange, its notify hook ${aborted ? "did not settle before the run was cancelled" : "failed"}, and denying the deferral failed; its resume link may stay live (deferral "${ctx.deferralId}", see the error log).`,
    });
  } finally {
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

/** Sentinel for the abort arm, so it is distinguishable from a thrown cause. */
const NOTIFY_ABORTED = Symbol("routecraft.deferral.notify.aborted");

/**
 * The record a deferral writes, and the exchange it was taken from.
 *
 * Shared by the two ways an exchange reaches the store: a `.defer()`
 * deferral, which replaces the run's outcome with the acknowledgment, and an
 * aside deferral, which stores a continuation for a run that completes
 * normally. Both must agree on the id, the sequence, the serialised
 * exchange and the hash, or a revival of one would not find what the
 * other wrote.
 */
function describeRecord(
  exchange: Exchange,
  routeId: string,
  request: Pick<
    DeferRequest,
    "site" | "schema" | "meta" | "callBinding" | "stepState" | "errorPath"
  >,
  ttlMs: number | undefined,
): { id: string; deferring: Exchange; record: NewDeferral } {
  const floor = asideSequenceOf(exchange);
  const sequence = effectiveSequence(exchange.headers, floor);
  const id = deferralIdOf(exchange.headers, exchange.id, floor);
  // The deferred exchange carries the sequence its successor will use, so a
  // route that defers, resumes, and defers again mints a fresh id
  // rather than colliding with the record it just settled.
  const deferring = DefaultExchange.rewrap(exchange, {
    headers: {
      ...exchange.headers,
      [DeferralHeaders.SEQUENCE]: sequence + 1,
    },
  });

  const schema = describeSchema(request.schema);
  const serialized = serializeExchange(deferring);
  // The site's continuation is exactly what a resume would run: for a
  // static `.defer()` it excludes the step itself (it already ran), and
  // for a re-entrant site it includes it (it runs again). The hash covers
  // whichever is true.
  const hash = continuationTailHash(request.site.continuation, schema);
  // `stepState` crosses the persistence boundary raw: the store's `create`
  // applies the same plain-JSON rule as the exchange (both backends encode
  // it, refusing a resolver, a secret, or a non-envelope Date with RC5042),
  // so the deferral still fails here rather than surprising the revival, and
  // encoding happens exactly once. Encoding it here too would double-wrap
  // the Date envelope, which the second pass refuses as a reserved shape.
  const stepState = request.stepState;
  const deferredAt = new Date();
  const record: NewDeferral = {
    id,
    routeId,
    position: request.site.position,
    continuationHash: hash,
    exchange: serialized,
    schema,
    ...(request.meta !== undefined ? { meta: request.meta } : {}),
    ...(request.callBinding !== undefined
      ? { callBinding: request.callBinding }
      : {}),
    ...(request.errorPath !== undefined
      ? { errorPath: request.errorPath }
      : {}),
    ...(stepState !== undefined ? { stepState } : {}),
    actionFingerprint: actionFingerprint({
      routeId,
      position: request.site.position,
      continuationHash: hash,
      exchange: serialized,
    }),
    deferredAt,
    waitingFor: "resume",
    ...(ttlMs !== undefined
      ? { expiresAt: new Date(deferredAt.getTime() + ttlMs) }
      : {}),
  };
  return { id, deferring, record };
}

/**
 * Store a continuation for an exchange that completes normally.
 *
 * A `.defer()` deferral ends the run and answers with the acknowledgment. An
 * aside deferral does not: the run goes on to complete, and what is stored is
 * a way to re-enter the route at `site` later, on this process, with the
 * exchange's body and headers exactly as a deferral stores them. The agent
 * tier uses it for a session turn that ends with work still outstanding
 * (a background tool running, messages queued): the caller has its reply,
 * and the continuation is what a completion revives to run the next turn
 * and the route's downstream steps.
 *
 * No `route:exchange:deferred` is emitted and the exchange is not marked
 * deferred, because it is not: it completes, and one `exchange:started`
 * must reach exactly one terminal. Revival is a first-class run of the
 * route with its own pair. The record carries no deadline, since what it
 * waits on has none the framework knows.
 *
 * @param stepState - Built from the deferral id, so the state a revival
 *   hands back can name the record it came from
 * @param announce - Awaited with the id BEFORE the record is written, so
 *   the caller's own record can name the deferral from the first write on.
 *   The opposite ordering to the `notify` hook a `recovery.defer()` directive
 *   carries, which is awaited AFTER its write: this one hands an id to an
 *   in-process caller that can release a dangling reference, while that one
 *   hands a token to a person, and a person must never hold a link to a
 *   record that does not exist. The commit ordering is the safety property in
 *   both, which is why they do not share a word.
 * @returns The deferral id, which `reviveDeferral` takes back
 * @throws RC5052 without a deferral runtime, RC5042 when the exchange
 *   cannot be persisted, RC5044 when the store write fails
 *
 * @internal
 */
export async function deferAside(
  context: CraftContext,
  exchange: Exchange,
  site: DeferRequest["site"],
  routeId: string,
  stepState: (deferralId: string) => unknown,
  announce?: (deferralId: string) => Promise<void>,
): Promise<{ deferralId: string }> {
  const runtime = context.getStore(DEFERRAL_RUNTIME);
  if (!runtime) {
    throw rcError("RC5052", undefined, {
      message: `Route "${routeId}" needs a continuation stored for a later turn, and this context has no deferral runtime. Add deferral: {} to defineConfig.`,
    });
  }
  const floor = asideSequenceOf(exchange);
  const sequence = effectiveSequence(exchange.headers, floor);
  const id = deferralIdOf(exchange.headers, exchange.id, floor);
  const { record } = describeRecord(
    exchange,
    routeId,
    { site, stepState: stepState(id) },
    undefined,
  );
  // The caller learns the id before the record exists, so what it keeps
  // can name the deferral from the first write on: a crash between the two
  // leaves a reference to release, not a record nothing points at, and an
  // aside deferral has no expiry to retire it otherwise. The `notify` hook
  // on a `recovery.defer()` directive commits the other way round; see this
  // function's `@param announce` for why both are correct.
  if (announce) await announce(id);
  await runtime.store.create(record);
  // The run goes on with this exchange, and its headers are frozen: the
  // successor sequence the record carries is noted on the exchange too,
  // so a `.defer()` later in the same run does not derive this id.
  noteAsideSequence(exchange, sequence + 1);
  return { deferralId: id };
}

/**
 * Deny a deferral that committed and must not stay resumable.
 *
 * Two raisers, one shape. A run cancelled after the store write: the abort
 * raced the write and lost, so a caller being told the run failed would
 * otherwise leave a live resume link, and an approver clicking it days later
 * would run a continuation for work whose caller already saw a cancellation.
 * And a `notify` hook that threw or never settled: nobody was successfully
 * told, so nobody may hold a working link.
 *
 * Claim-first, like expiry and the changed-continuation denial, so a crash
 * between the transition and the caller's error still leaves the record
 * deniable rather than stuck. No re-ask is delivered: the error the caller
 * receives IS the notification, and a later replay of the token reads the
 * denial as `RC5050` from the settled path.
 *
 * Best effort by design: the caller's error must reach it whatever the store
 * does, so a store failure here is logged and swallowed. The return value
 * keeps that error honest about what happened.
 *
 * @param reason - Recorded on the denial and read back by a later replay
 * @returns Whether the record is confirmed settled (denied here, or already
 *   settled by whoever won the claim). `false` means the denial failed and
 *   the resume link may still be live.
 *
 * @internal
 */
async function denyDeferred(
  context: CraftContext,
  exchange: Exchange,
  deferralId: string,
  routeId: string,
  reason: string,
  expiresAt?: Date,
): Promise<boolean> {
  const runtime = context.getStore(DEFERRAL_RUNTIME);
  if (!runtime) return false;
  try {
    const claim = await runtime.store.claimExpiry(deferralId, new Date());
    // Losing the claim means someone else already settled the record (an
    // resume that raced in, the sweeper). Whoever won owns the outcome.
    if (!claim.won) return true;
    // `markDenied` is itself a compare-and-swap against the claim. Reporting
    // a confirmed denial without reading it would be the one thing this
    // return value exists to prevent: if the claim's lease elapsed in
    // between, `releaseClaims` has cleared it, the record is resumable
    // again, and the link the caller was told is dead comes back.
    const denied = await runtime.store.markDenied(deferralId, reason);
    if (!denied.won) {
      exchange.logger.error(
        { deferralId, routeId, reason, expiresAt },
        "A deferral that had to be denied lost its denial transition, so its resume link may become live again when the expiry claim is released.",
      );
    }
    return denied.won;
  } catch (err) {
    exchange.logger.error(
      { deferralId, routeId, reason, expiresAt, err },
      expiresAt
        ? "Could not deny a deferral that had to be denied. Its resume link stays live until the ttl retires it."
        : 'Could not deny a deferral that had to be denied. It has no ttl (defaultTtl: "never"), so its resume link stays live until it is settled by hand.',
    );
    return false;
  }
}
