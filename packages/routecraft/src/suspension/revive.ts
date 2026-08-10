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
import { continuationHash } from "./hash.ts";
import { SuspensionHeaders } from "./exchange-state.ts";
import { SUSPENSION_RUNTIME } from "./runtime-key.ts";
import { deserializeExchange, encodePersistable } from "./serialize.ts";
import type { SuspendSite } from "./sites.ts";
import type { PrincipalRef, SerializedOutcome, Suspension } from "./types.ts";

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
 * 5. The answer satisfies the suspending step's `expect` (`RC5049`).
 * 6. The compare-and-swap out of `suspended` is won here and not by a
 *    concurrent resume or the expiry sweeper.
 *
 * Failures that leave an approver stranded (expiry, a changed continuation,
 * a denied suspension, a rejected answer) additionally re-enter the
 * SUSPENDED route's error channel, so a route-scope `.error()` can notify
 * and re-ask instead of the answer vanishing into the ingress route's own
 * failure. The ingress caller still sees the typed error.
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
    return settled(context, suspension);
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
  if (
    suspension.expiresAt !== undefined &&
    suspension.expiresAt.getTime() <= Date.now()
  ) {
    context.emit("route:exchange:expired", {
      routeId: suspension.routeId,
      exchangeId: exchangeIdOf(suspension),
      correlationId: correlationIdOf(suspension),
      suspensionId: id,
      expiresAt: suspension.expiresAt,
    });
    throw await reask(
      context,
      route,
      suspension,
      rcError("RC5047", undefined, {
        message: `Suspension "${id}" expired at ${suspension.expiresAt.toISOString()}.`,
      }),
    );
  }

  const site = findSite(route, suspension);
  if (!site) {
    throw await reask(
      context,
      route,
      suspension,
      rcError("RC5048", undefined, {
        message: `Route "${suspension.routeId}" no longer has a .suspend() at position ${suspension.position}.`,
      }),
    );
  }

  const current = continuationHash(
    [site.step, ...site.site.continuation],
    0,
    suspension.expect,
  );
  if (current !== suspension.continuationHash) {
    throw await reask(
      context,
      route,
      suspension,
      rcError("RC5048", undefined, {
        message: `Route "${suspension.routeId}" changed after position ${suspension.position} while this exchange was parked, so the stored answer no longer authorizes what would run.`,
      }),
    );
  }

  // Validation runs against the LIVE schema read off the route, not
  // anything in the record: a Standard Schema is an object with a validate
  // function and cannot be persisted. The record holds only a hash of it,
  // folded into `continuationHash`, so a schema that changed under the
  // parked exchange was already refused above.
  const result = await validateAgainst(site.expect, request.result);
  if (!result.ok) {
    throw await reask(
      context,
      route,
      suspension,
      rcError("RC5049", result.message, {
        message: `The answer for suspension "${id}" does not satisfy the expect schema: ${result.message}`,
      }),
    );
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
    return settled(context, cas.suspension, route);
  }

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

  const outcome = await runContinuation(
    route,
    exchange,
    site.site.continuation,
    resumedAt,
  );
  await runtime.store.recordTerminal(id, outcome);

  return {
    status: "resumed",
    suspensionId: id,
    routeId: suspension.routeId,
    outcome,
  };
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
async function settled(
  context: CraftContext,
  suspension: Suspension,
  route?: Route,
): Promise<ResumeAcknowledgment> {
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

  const target = route ?? context.getRouteById(suspension.routeId);
  const error =
    suspension.status === "expired"
      ? rcError("RC5047", undefined, {
          message: `Suspension "${suspension.id}" expired before an answer arrived.`,
        })
      : rcError("RC5050", undefined, {
          message: `Suspension "${suspension.id}" was denied${suspension.deniedReason ? `: ${suspension.deniedReason}` : ""}.`,
        });
  throw target ? await reask(context, target, suspension, error) : error;
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
  const result = await route.runContinuation(exchange, [...continuation]);
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
