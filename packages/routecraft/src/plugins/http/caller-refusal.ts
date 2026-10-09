import type { Principal } from "../../principal.ts";
import type { RefusalKind } from "../../kernel/hooks.ts";
import {
  callerRefusalOf,
  type CallerRefusal,
} from "../../pipeline/caller-refusal.ts";
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

/**
 * Answer a route failure the caller caused with a client status, or return
 * `undefined` for one the instance owns.
 *
 * The http rendering of {@link callerRefusalOf}, which decides whose failure
 * it is. Shared by the `http()` source and the ops dispatch mount, so the
 * same refusal cannot be a 403 on one and a 500 on the other. Each door
 * keeps its own fallthrough 500 and whatever codes only it answers.
 *
 * - `input`: 400 with the part that failed and the schema's issues, the
 *   ones left out counted in `truncated`.
 * - `unauthenticated`: the door's own unauthenticated answer.
 * - `expired`: 401 `expired`, with an RFC 6750 `invalid_token` challenge on
 *   a bearer principal so the client refreshes.
 * - `insufficient_permissions`: 403 `insufficient_permissions`.
 * - `insufficient_scope`: 403 `insufficient_scope`, in the shape the ops
 *   tier check already answers, naming the scopes.
 *
 * @internal
 */
export function callerRefusalResponse(
  error: unknown,
  context: CallerRefusalContext,
): Response | undefined {
  const refusal = callerRefusalOf(error, {
    routeId: context.routeId,
    principal: context.principal,
    credentialCouldHelp: context.unauthenticated !== undefined,
  });
  if (refusal === undefined) return undefined;
  const scheme = context.principal?.scheme;
  switch (refusal.kind) {
    case "input":
      return jsonResponse(
        {
          error: "bad request",
          code: "RC5065",
          in: refusal.in,
          issues: refusal.issues,
          ...(refusal.omitted > 0 ? { truncated: refusal.omitted } : {}),
        },
        { status: 400 },
      );
    case "unauthenticated":
      return context.unauthenticated?.();
    case "expired":
      return jsonResponse(
        { error: "unauthorized", reason: "expired" },
        {
          status: 401,
          headers: bearerChallengeHeaders(scheme, context.requestUrl, {
            error: "invalid_token",
          }),
        },
      );
    case "insufficient_permissions":
      return jsonResponse(
        { error: "forbidden", reason: "insufficient_permissions" },
        { status: 403 },
      );
    case "insufficient_scope":
      return insufficientScopeResponse(scheme, context.requestUrl, {
        scope: refusal.scopes.join(" "),
        anyOf: refusal.anyOf,
      });
    case "refused":
      return hookRefusalResponse(refusal, context);
  }
}

/** The status and the `error` word each refusal kind answers with. */
const REFUSAL_STATUS: Record<RefusalKind, { status: number; error: string }> = {
  invalid: { status: 400, error: "bad request" },
  unauthenticated: { status: 401, error: "unauthorized" },
  forbidden: { status: 403, error: "forbidden" },
  not_found: { status: 404, error: "not found" },
  conflict: { status: 409, error: "conflict" },
  gone: { status: 410, error: "gone" },
  rate_limited: { status: 429, error: "too many requests" },
  unavailable: { status: 503, error: "service unavailable" },
};

/**
 * A validate hook's refusal as the http doors answer it: the status its
 * kind maps to, the fixed `error` word, the code and the hook's reason.
 * `unauthenticated` is the door's own challenge, which the classification
 * guarantees exists by downgrading the kind when no credential is read.
 */
function hookRefusalResponse(
  refusal: Extract<CallerRefusal, { kind: "refused" }>,
  context: CallerRefusalContext,
): Response {
  if (refusal.as === "unauthenticated" && context.unauthenticated) {
    return context.unauthenticated();
  }
  const { status, error } = REFUSAL_STATUS[refusal.as];
  return jsonResponse(
    { error, code: "RC5068", reason: refusal.reason },
    { status },
  );
}
