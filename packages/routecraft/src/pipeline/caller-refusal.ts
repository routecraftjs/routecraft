import type { StandardSchemaV1 } from "@standard-schema/spec";
import { rcCodeOf } from "../brand.ts";
import { formatIssuePath } from "../error.ts";
import {
  insufficientAuthorityOf,
  isAuthorizationRefusal,
} from "../authorization-refusal.ts";
import type { Principal } from "../principal.ts";
import { isHookRefusal, type RefusalKind } from "../kernel/hooks.ts";
import { isInputValidationFailure } from "./validation.ts";

/** One schema issue as a door shows it to a caller: where, and what. */
export interface WireIssue {
  /** Dot-joined issue path, absent for an issue about the whole value. */
  path?: string;
  message: string;
}

/**
 * Schema issues bounded for the wire: the first {@link MAX_WIRE_ISSUES}, and
 * how many more there were.
 */
export interface WireIssues {
  issues: WireIssue[];
  /** Issues left out of `issues`; `0` when all of them fit. */
  omitted: number;
}

/**
 * How many schema issues a door sends. A payload with thousands of bad array
 * items would otherwise produce an answer proportional to the damage.
 */
export const MAX_WIRE_ISSUES = 20;

/**
 * The longest path or message a wire issue carries. A path echoes the
 * caller's own keys, so a record key of a megabyte repeated across every
 * issue would make the answer many times the size of the request.
 */
const MAX_WIRE_ISSUE_TEXT = 256;

/**
 * Cut by code point, ellipsis included, so a cut never splits a surrogate
 * pair. Only the head is walked: a code point spans at most two UTF-16
 * units, so twice the cap in units holds every code point that can survive.
 */
function clip(text: string): string {
  if (text.length <= MAX_WIRE_ISSUE_TEXT) return text;
  const chars = Array.from(text.slice(0, MAX_WIRE_ISSUE_TEXT * 2));
  return text.length <= MAX_WIRE_ISSUE_TEXT * 2 &&
    chars.length <= MAX_WIRE_ISSUE_TEXT
    ? text
    : `${chars.slice(0, MAX_WIRE_ISSUE_TEXT - 3).join("")}...`;
}

/**
 * Reduce Standard Schema issues to what a door may put on the wire: each
 * issue's path and message, at most {@link MAX_WIRE_ISSUES} of them, each
 * clipped to {@link MAX_WIRE_ISSUE_TEXT} characters.
 *
 * The message is the schema's own text, so a schema author's custom message
 * reaches the caller verbatim. A non-string message becomes `"invalid"`.
 *
 * @param issues - The issues a schema returned
 * @returns The first issues as path and message, and the count left out
 */
export function wireIssues(
  issues: readonly StandardSchemaV1.Issue[],
): WireIssues {
  return {
    issues: issues.slice(0, MAX_WIRE_ISSUES).map((issue) => {
      const path = formatIssuePath(issue.path);
      return {
        ...(path !== undefined ? { path: clip(path) } : {}),
        message:
          typeof issue.message === "string" ? clip(issue.message) : "invalid",
      };
    }),
    omitted: Math.max(0, issues.length - MAX_WIRE_ISSUES),
  };
}

/**
 * A route failure the caller caused, classified by what the caller can do
 * about it. Each door renders it in its own protocol: an http status and
 * body, an MCP tool error, and so on.
 *
 * - `input`: the route's `.input()` schema refused what the caller sent.
 *   Carries the part and the issues, never the error message, which names
 *   the route.
 * - `unauthenticated`: the route needs an identity and the caller presented
 *   none.
 * - `expired`: the caller's credential expired while the route ran.
 * - `insufficient_permissions`: the identity is not permitted, as itself or
 *   through the delegation it arrived by. One class for four codes, because
 *   the caller's remedy is the same and naming the check that failed would
 *   tell a prober which part of the policy it tripped.
 * - `insufficient_scope`: the credential lacks a scope. `scopes` lists the
 *   missing ones, or with `anyOf` the whole accepted set, of which one
 *   suffices.
 * - `refused`: a plugin's validate hook refused the exchange on the
 *   dispatched route. `as` is the hook's own say over the answer and
 *   `reason` its words for the caller, clipped like a schema issue. The hook
 *   and the slot stay in the log: naming them would tell a prober which
 *   plugin it tripped.
 */
export type CallerRefusal =
  | ({ kind: "input"; in: "body" | "headers" } & WireIssues)
  | { kind: "unauthenticated" }
  | { kind: "expired" }
  | { kind: "insufficient_permissions" }
  | { kind: "insufficient_scope"; scopes: string[]; anyOf: boolean }
  | { kind: "refused"; as: RefusalKind; reason: string };

/** What a door knows about the call whose route failed. */
export interface CallerRefusalOrigin {
  /**
   * The route the door dispatched. A failure raised by any other route
   * reached this one through a `direct()` call, and what that route refused
   * was this route's doing rather than the caller's.
   */
  routeId: string;
  /**
   * The principal the door put on the exchange, by reference, or `undefined`
   * when it put none. A refusal maps only when it is this exact principal
   * that `authorize()` refused.
   */
  principal: Principal | undefined;
  /**
   * Whether presenting a credential could have changed the outcome: the
   * door consulted a validator and the call went without a principal.
   *
   * Decides whether a missing principal (`RC5012`) is the caller's to fix.
   * When it is not, the door never reads a credential for this route, so
   * telling the caller to present one would send it after something that
   * changes nothing, and the failure stays the route's.
   */
  credentialCouldHelp?: boolean;
}

/**
 * Classify a route failure the caller caused, or return `undefined` for one
 * the instance owns.
 *
 * One classification for every door that runs a route on a caller's behalf
 * (the `http()` source, the ops dispatch mount, the MCP server), so the same
 * refusal cannot be the caller's on one door and the instance's on another.
 * A door answers everything this returns `undefined` for with the error
 * code alone: an error message routinely interpolates the cause, and the
 * cause of a route failure is whatever its steps threw, hostnames, file
 * paths and upstream response text included.
 *
 * Attribution is by origin, never by code:
 *
 * - `RC5065` maps only when it carries the `InputValidationFailure` detail
 *   for the dispatched route. One without it was thrown by something other
 *   than `.input()`, and one naming another route came up through
 *   `direct()`, so neither is the caller's.
 * - `RC5068` maps only when it carries the `HookRefusal` detail for the
 *   dispatched route, for the same reason. A hook refusing as
 *   `unauthenticated` on a door that reads no credential is answered as
 *   `forbidden`: a challenge would send the caller after a credential the
 *   door never reads.
 * - The authorization codes map only when {@link isAuthorizationRefusal}
 *   says `authorize()` raised them on the dispatched route about the
 *   principal the door admitted. The same codes come out of adapters for an
 *   upstream login refused, and a check of an identity the pipeline swapped
 *   in (`.authenticate()`, a delegation) refused the instance; both stay the
 *   instance's, which also keeps an internal identity's requirements off the
 *   wire. `RC5012` additionally needs `credentialCouldHelp`. `RC5023` (a
 *   self-asserted principal) and `RC5043` (one restored from a deferral) are
 *   never mapped: a door brands every principal it verifies, so either one
 *   was put there by the route.
 *
 * @param error - What the route threw
 * @param origin - The dispatched route and the principal the door admitted
 * @returns The refusal to render, or `undefined` when the failure is the instance's
 */
export function callerRefusalOf(
  error: unknown,
  origin: CallerRefusalOrigin,
): CallerRefusal | undefined {
  const code = rcCodeOf(error);
  if (code === "RC5065") {
    const cause = (error as Error).cause;
    if (
      !isInputValidationFailure(cause) ||
      cause.invalid.routeId !== origin.routeId
    ) {
      return undefined;
    }
    return {
      kind: "input",
      in: cause.invalid.in,
      ...wireIssues(cause.invalid.issues),
    };
  }
  if (code === "RC5068") {
    const cause = (error as Error).cause;
    if (!isHookRefusal(cause) || cause.refused.routeId !== origin.routeId) {
      return undefined;
    }
    const as =
      cause.refused.kind === "unauthenticated" &&
      origin.credentialCouldHelp !== true
        ? "forbidden"
        : cause.refused.kind;
    return { kind: "refused", as, reason: clip(cause.refused.reason) };
  }
  if (
    !isAuthorizationRefusal(error, {
      routeId: origin.routeId,
      principal: origin.principal,
    })
  ) {
    return undefined;
  }
  switch (code) {
    case "RC5012":
      return origin.credentialCouldHelp === true
        ? { kind: "unauthenticated" }
        : undefined;
    case "RC5020":
      return { kind: "expired" };
    case "RC5015":
    case "RC5034":
    case "RC5035":
    case "RC5036":
      return { kind: "insufficient_permissions" };
    case "RC5038": {
      const missing = insufficientAuthorityOf(error);
      return {
        kind: "insufficient_scope",
        scopes: [...(missing?.scopes ?? [])],
        anyOf: missing?.mode === "any",
      };
    }
    default:
      return undefined;
  }
}
