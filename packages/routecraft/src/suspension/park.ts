import type { CraftContext } from "../context.ts";
import { rcError } from "../error.ts";
import {
  type Exchange,
  DefaultExchange,
  HeadersKeys,
  markSuspended,
} from "../exchange.ts";
import type { Adapter, Step } from "../types.ts";
import type { SuspendRequest } from "./sites.ts";
import { actionFingerprint, continuationHash, describeExpect } from "./hash.ts";
import { SuspensionHeaders, readSequence } from "./exchange-state.ts";
import { SUSPENSION_RUNTIME } from "./runtime-key.ts";
import { serializeExchange } from "./serialize.ts";
import { type Suspended, createSuspended } from "./suspended.ts";
import { suspensionIdFor } from "./tokens.ts";
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
 * @param step - The suspending step, which heads the array the continuation
 *   hash is taken over (the hash itself covers everything after it)
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
  step: Step<Adapter>,
): Promise<Exchange> {
  const runtime = context.getStore(SUSPENSION_RUNTIME);
  if (!runtime) {
    throw rcError("RC5052", undefined, {
      message: `Route "${routeId}" reached a .suspend() but this context has no suspension runtime. Add suspension: {} to defineConfig.`,
    });
  }

  const sequence = readSequence(exchange.headers);
  const id = suspensionIdFor(exchange.id, sequence);
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
  // The suspending step heads the array so `continuationHash`'s
  // "position + 1 onward" lands exactly on the site's continuation. The
  // step's own definition is excluded, which is the point: it already ran.
  const hash = continuationHash(
    [step, ...request.site.continuation],
    0,
    expect,
  );
  const suspendedAt = new Date();
  const record: NewSuspension = {
    id,
    routeId,
    position: request.site.position,
    continuationHash: hash,
    exchange: serialized,
    expect,
    actionFingerprint: actionFingerprint({
      routeId,
      position: request.site.position,
      continuationHash: hash,
      exchange: serialized,
    }),
    suspendedAt,
    ...(request.expiresInMs !== undefined
      ? { expiresAt: new Date(suspendedAt.getTime() + request.expiresInMs) }
      : {}),
  };

  await runtime.store.create(record);

  const suspended: Suspended = createSuspended({
    suspensionId: id,
    token: runtime.signer.mint(id),
    ...(expect.jsonSchema !== undefined ? { expect: expect.jsonSchema } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
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
