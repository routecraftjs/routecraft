import type { CraftContext } from "../context.ts";
import { rcError } from "../error.ts";
import {
  type Exchange,
  DefaultExchange,
  HeadersKeys,
  markSuspended,
} from "../exchange.ts";
import type { SuspendRequest } from "./sites.ts";
import {
  actionFingerprint,
  continuationTailHash,
  describeExpect,
} from "./hash.ts";
import {
  SuspensionHeaders,
  readSequence,
  suspensionIdOf,
} from "./exchange-state.ts";
import { SUSPENSION_RUNTIME } from "./runtime-key.ts";
import { encodePersistable, serializeExchange } from "./serialize.ts";
import { type Suspended, createSuspended } from "./suspended.ts";
import type { NewSuspension } from "./types.ts";

/**
 * Park an exchange: everything that happens between a `.suspend()`
 * producing its outcome and execution one answering.
 *
 * Ordering is deliberate and load-bearing. The exchange is serialized
 * FIRST, so the three serialization rules (no live values, no secrets, no
 * live-verified principal) fail the step before anything is written or
 * emitted; the store write comes next, so nothing is announced that cannot
 * be resumed; the mark and the event come last, once the suspension is
 * durable. A failure anywhere in here is an ordinary step failure and
 * reaches the route's `.error()` handler, because the exchange has not been
 * parked and the route still owns it.
 *
 * @param context - Context whose suspension runtime holds the store and signer
 * @param exchange - The exchange as the suspend step handed it over
 * @param request - What the suspend step resolved: schema, TTL, and site
 * @param routeId - Route the parked exchange belongs to
 * @returns The exchange execution one terminates with, its body replaced by
 *   the {@link Suspended} acknowledgment
 * @throws RC5052 when the context has no suspension runtime, RC5042 when
 *   the exchange cannot be persisted, RC5044 when the store write fails
 *
 * @internal
 */
export async function parkExchange(
  context: CraftContext,
  exchange: Exchange,
  request: SuspendRequest,
  routeId: string,
): Promise<Exchange> {
  const runtime = context.getStore(SUSPENSION_RUNTIME);
  if (!runtime) {
    throw rcError("RC5052", undefined, {
      message: `Route "${routeId}" reached a .suspend() but this context has no suspension runtime. Add suspension: {} to defineConfig.`,
    });
  }

  const sequence = readSequence(exchange.headers);
  const id = suspensionIdOf(exchange.headers, exchange.id);
  // The parked exchange carries the sequence its successor will use, so a
  // route that suspends, resumes, and suspends again mints a fresh id
  // rather than colliding with the record it just settled.
  const parking = DefaultExchange.rewrap(exchange, {
    headers: {
      ...exchange.headers,
      [SuspensionHeaders.SEQUENCE]: sequence + 1,
    },
  });

  const expect = describeExpect(request.expect);
  const serialized = serializeExchange(parking);
  // The site's continuation is exactly what a resume would run: for a
  // static `.suspend()` it excludes the step itself (it already ran), and
  // for a re-entrant site it includes it (it runs again). The hash covers
  // whichever is true.
  const hash = continuationTailHash(request.site.continuation, expect);
  // The plain-JSON rule applies to step-owned closure state the same as to
  // the exchange: a resolver, a Date without the envelope, or a secret in
  // there must fail the park, not surprise the revival.
  const stepState =
    request.stepState !== undefined
      ? encodePersistable(request.stepState, "stepState")
      : undefined;
  const suspendedAt = new Date();
  const ttlMs = request.expiresInMs ?? runtime.defaultTtlMs;
  const record: NewSuspension = {
    id,
    routeId,
    position: request.site.position,
    continuationHash: hash,
    exchange: serialized,
    expect,
    ...(stepState !== undefined ? { stepState } : {}),
    actionFingerprint: actionFingerprint({
      routeId,
      position: request.site.position,
      continuationHash: hash,
      exchange: serialized,
    }),
    suspendedAt,
    // Per-suspend `ttl` first, then the context default. A suspension with
    // no deadline at all is only reachable through `defaultTtl: "never"`,
    // because an approval nobody answers should eventually reach the route
    // that asked for it rather than sit in the store forever.
    ...(ttlMs !== undefined
      ? { expiresAt: new Date(suspendedAt.getTime() + ttlMs) }
      : {}),
  };

  await runtime.store.create(record);

  // After the durable write, not before: this file's ordering promises that
  // nothing is announced that cannot be resumed, and a park that fails at
  // serialization or the store write must not leave an operator a warning
  // about a suspension that never existed.
  if (expect.degraded) {
    parking.logger.warn(
      { suspensionId: id, routeId, position: request.site.position },
      "The expect schema advertises a JSON Schema extension that produced nothing, so this suspension cannot detect a changed expect: only the step tail is covered. Zod throws for a Date, a bigint or any transform.",
    );
  }

  const suspended: Suspended = createSuspended({
    suspensionId: id,
    token: runtime.signer.mint(id),
    ...(expect.jsonSchema !== undefined ? { expect: expect.jsonSchema } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
    ...(request.question !== undefined ? { question: request.question } : {}),
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
  });

  const parked = DefaultExchange.rewrap(parking, { body: suspended });
  markSuspended(parked);
  context.emit("route:exchange:suspended", {
    routeId,
    exchangeId: parked.id,
    correlationId: parked.headers[HeadersKeys.CORRELATION_ID] as string,
    suspensionId: id,
    position: request.site.position,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
  });
  parked.logger.info(
    { suspensionId: id, routeId, position: request.site.position },
    "Exchange suspended",
  );
  return parked;
}

/**
 * Deny a suspension whose run was cancelled after the park committed.
 *
 * The abort raced the store write and lost, so a caller who is being told
 * the run failed would otherwise leave behind a live resume link: an
 * approver clicking it days later would run a continuation for work whose
 * caller already saw a cancellation. Claim-first, like expiry and the
 * changed-continuation denial, so a crash between the transition and the
 * caller's cancellation error still leaves the record deniable rather than
 * stuck. No re-ask is delivered: the cancellation error the caller receives
 * IS the notification, and a later replay of the token reads the denial as
 * `RC5050` from the settled path.
 *
 * Best effort by design: the cancellation error must reach the caller
 * whatever the store does, so a store failure here is logged and swallowed.
 *
 * @internal
 */
export async function denyParkedOnCancellation(
  context: CraftContext,
  exchange: Exchange,
  suspensionId: string,
  routeId: string,
): Promise<void> {
  const runtime = context.getStore(SUSPENSION_RUNTIME);
  if (!runtime) return;
  try {
    const claim = await runtime.store.claimExpiry(suspensionId, new Date());
    // Losing the claim means someone else already settled the record (an
    // answer that raced in, the sweeper). Whoever won owns the outcome.
    if (!claim.won) return;
    await runtime.store.markDenied(suspensionId, "run cancelled");
  } catch (err) {
    exchange.logger.error(
      { suspensionId, routeId, err },
      "Could not deny a suspension parked by a cancelled run. Its resume link stays live until the ttl retires it.",
    );
  }
}
