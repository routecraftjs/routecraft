import { rcCodeOf } from "../../brand.ts";
import { formatIssuePath } from "../../error.ts";
import {
  isAuthorizationRefusal,
  type InsufficientAuthority,
} from "../../auth/authorize.ts";
import type { Principal } from "../../auth/types.ts";
import { isInputValidationFailure } from "../../pipeline/validation.ts";
import {
  bearerChallengeHeaders,
  insufficientScopeResponse,
  jsonResponse,
} from "./response.ts";

/**
 * What a door knows about the request whose route failed.
 *
 * @internal
 */
export interface CallerRefusalContext {
  /**
   * The route the door dispatched. A failure raised by any other route
   * reached this one through a `direct()` call, and what that route refused
   * was this route's doing rather than the caller's.
   */
  routeId: string;
  /** The request URL, for the RFC 9728 hint on a bearer challenge. */
  requestUrl: string;
  /**
   * The principal the door admitted, if any. Its scheme picks the
   * challenge, and a refusal maps only when it is this exact principal
   * that `authorize()` refused.
   */
  principal?: Principal | undefined;
  /**
   * What the door answers a caller who had to authenticate and did not,
   * supplied only when a credential could have changed the outcome: the
   * door consulted a validator and the request went without a principal.
   *
   * Decides whether a missing principal (`RC5012`) is the caller's to fix.
   * Unset, it is not: the door never reads a credential for this route, so
   * a 401 would send the caller to present one that would change nothing,
   * and the failure stays the route's.
   */
  unauthenticated?: (() => Response) | undefined;
}

/** One `.input()` schema issue as the caller receives it. */
interface WireIssue {
  path?: string;
  message: string;
}

/**
 * Answer a route failure the caller caused with a client status, or return
 * `undefined` for one the instance owns.
 *
 * One mapping for every door that runs a route on a caller's behalf (the
 * `http()` source and the ops dispatch mount), so the same refusal cannot
 * be a 403 on one and a 500 on the other. Each door keeps its own
 * fallthrough 500 and whatever codes only it answers.
 *
 * Mapped:
 *
 * - `RC5065` (`.input()` refused the payload): 400 with the part that
 *   failed and the schema's issues, at most {@link MAX_WIRE_ISSUES} of them
 *   with the rest counted in `truncated`. Never the error message, which
 *   names the route. Only an RC5065 carrying the `InputValidationFailure`
 *   detail for the dispatched route maps: one without it was thrown by
 *   something other than `.input()`, and one naming another route came up
 *   through `direct()`, so neither is the caller's.
 * - `RC5012` (no principal): the door's own unauthenticated answer, only
 *   when the door says a credential could have changed the outcome.
 * - `RC5020` (the credential expired in flight): 401 `expired`, with an
 *   RFC 6750 `invalid_token` challenge on a bearer principal so the client
 *   refreshes.
 * - `RC5015`, `RC5034`, `RC5035`, `RC5036` (the identity is not permitted,
 *   as itself or through the delegation it arrived by): 403
 *   `insufficient_permissions`. The four collapse on the wire because the
 *   caller's remedy is the same, and naming which check failed would tell a
 *   prober which part of the policy it tripped.
 * - `RC5038` (a scope is missing): 403 `insufficient_scope`, in the shape
 *   the ops tier check already answers, naming the scopes.
 *
 * The authorization codes map only when {@link isAuthorizationRefusal}
 * says `authorize()` raised them on the dispatched route about the
 * principal the door admitted: the same codes come out of adapters for an
 * upstream login refused, and a check of an identity the pipeline swapped
 * in (`.authenticate()`, a delegation) refused the instance. Both stay a
 * 500, which also keeps an internal identity's requirements off the wire.
 * `RC5023` (a self-asserted principal) and `RC5043` (one restored from a
 * deferral) are not mapped: a door brands every principal it verifies, so
 * either one was put there by the route and is the route's fault.
 *
 * @internal
 */
export function callerRefusalResponse(
  error: unknown,
  context: CallerRefusalContext,
): Response | undefined {
  const code = rcCodeOf(error);
  if (code === "RC5065") return inputRefused(error as Error, context.routeId);
  if (
    !isAuthorizationRefusal(error, {
      routeId: context.routeId,
      principal: context.principal,
    })
  ) {
    return undefined;
  }
  const scheme = context.principal?.scheme;
  switch (code) {
    case "RC5012":
      return context.unauthenticated?.();
    case "RC5020":
      return jsonResponse(
        { error: "unauthorized", reason: "expired" },
        {
          status: 401,
          headers: bearerChallengeHeaders(scheme, context.requestUrl, {
            error: "invalid_token",
          }),
        },
      );
    case "RC5015":
    case "RC5034":
    case "RC5035":
    case "RC5036":
      return jsonResponse(
        { error: "forbidden", reason: "insufficient_permissions" },
        { status: 403 },
      );
    case "RC5038":
      return scopeRefused(error, scheme, context.requestUrl);
    default:
      return undefined;
  }
}

/**
 * How many schema issues a 400 carries. The rest are counted in
 * `truncated`: a payload with thousands of bad array items would otherwise
 * produce a response body proportional to the damage.
 */
const MAX_WIRE_ISSUES = 20;

function inputRefused(error: Error, routeId: string): Response | undefined {
  const cause = error.cause;
  if (!isInputValidationFailure(cause) || cause.invalid.routeId !== routeId) {
    return undefined;
  }
  const { issues } = cause.invalid;
  const omitted = issues.length - MAX_WIRE_ISSUES;
  return jsonResponse(
    {
      error: "bad request",
      code: "RC5065",
      in: cause.invalid.in,
      issues: issues.slice(0, MAX_WIRE_ISSUES).map((issue): WireIssue => {
        const path = formatIssuePath(issue.path);
        return {
          ...(path !== undefined ? { path } : {}),
          message:
            typeof issue.message === "string" ? issue.message : "invalid",
        };
      }),
      ...(omitted > 0 ? { truncated: omitted } : {}),
    },
    { status: 400 },
  );
}

function scopeRefused(
  error: Error,
  scheme: string | undefined,
  requestUrl: string,
): Response {
  const missing = (error.cause as Partial<InsufficientAuthority> | undefined)
    ?.missing;
  return insufficientScopeResponse(scheme, requestUrl, {
    scope: (missing?.scopes ?? []).join(" "),
    anyOf: missing?.mode === "any",
  });
}
