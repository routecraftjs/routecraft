/**
 * What the three context-shaped handler points receive and may answer.
 *
 * `error` is not here: it is positional, so that one function body works
 * both as a route `.error()` operation and at the point, and it keeps its
 * types beside `ErrorHandler` in `route.ts`. The asymmetry is inherited
 * from the operation rather than invented here.
 *
 * Each point takes a context object rather than positional arguments for
 * the reason `error` cannot: a field can be added to an object without
 * changing a signature anyone has written.
 */

import type { Principal } from "../auth/types.ts";
import type { Exchange, ExchangeHeaders } from "../exchange.ts";
import type { RecoveryDrop } from "../recovery.ts";
import type { Route } from "../route.ts";

/**
 * Which run of an exchange a handler is looking at.
 *
 * `1` is the original, `2` a resumed continuation. An exchange that parks a
 * second time and resumes again stays `2`: the distinction is original
 * against continuation, not a park counter, which `ex.deferral.sequence`
 * already is.
 */
export type HandlerExecution = 1 | 2;

/** Headers a handler contributes, merged onto the exchange. */
export interface HeaderDecoration {
  readonly headers: Readonly<Record<string, unknown>>;
}

/**
 * Before the pre-from filter chain runs.
 *
 * Nothing has been validated and, for a source that carries no verifier, no
 * caller is known. This is where a plugin supplies what the transport could
 * not: a DKIM-verified sender, a signed platform event, an API key resolved
 * against a table.
 *
 * It carries no `execution`, and deliberately: a handler here may not
 * establish identity on a continuation at all (see
 * {@link AdmissionOutcome}), so there is no decision left for it to take
 * from knowing which run it is on.
 */
export interface AdmissionContext {
  /** The exchange as the source produced it. The body is unparsed. */
  readonly exchange: Exchange;
  /** The route the exchange is bound for. */
  readonly route: Route;
  /** Cut short when the route's intake stops. */
  readonly signal: AbortSignal;
}

/**
 * What an admission handler may answer.
 *
 * `{ principal }` is a distinct arm from `{ headers }` on purpose, and the
 * framework refuses three things through it rather than forbidding the act:
 *
 * - a principal that is not branded, because a plain object asserted onto
 *   the header would otherwise fail three positions later at `.authorize()`
 *   with `RC5023`, which reads as "your identity is forged" when the fault
 *   was "you asserted instead of minting";
 * - a principal at all when the exchange already carries an authentic one,
 *   because the transport verified it and nothing in the route would show
 *   that a plugin replaced it;
 * - a principal on a resumed continuation, because the restored one may
 *   carry scopes a human lent through `.resume(…, { elevate })`, and
 *   minting fresh would discard exactly the authority the step-up just
 *   obtained.
 *
 * `routecraft.auth.principal` inside `{ headers }` is refused for the same
 * reason the first arm exists: without that, the arm is decorative.
 */
export type AdmissionOutcome =
  HeaderDecoration | { readonly principal: Principal } | RecoveryDrop;

/**
 * After the pre-from chain, before the first user step.
 *
 * A known caller, a validated body, and none of the route's own work done.
 * This is the "if this route is one of mine, do X" point.
 */
export interface EntryContext {
  /** The exchange as the chain admitted it. */
  readonly exchange: Exchange;
  /** The route about to run. */
  readonly route: Route;
  /** `1` on the original run, `2` on a resumed continuation. */
  readonly execution: HandlerExecution;
  /** Cut short when the route stops, or an enclosing `.timeout()` expires. */
  readonly signal: AbortSignal;
}

/** What an entry handler may answer: decorate the exchange, or refuse it. */
export type EntryOutcome = HeaderDecoration | RecoveryDrop;

/**
 * After the last step, before the source receives the body.
 *
 * It does not run on a `Deferred` acknowledgment. A receipt saying the route
 * has not finished is not the route's output, and the acknowledgment carries
 * a live resume token: a handler that logs outgoing bodies, which is the
 * point's own use case, would log a resume token for every parked exchange.
 */
export interface ExitContext {
  /** The exchange as the route finished with it. */
  readonly exchange: Exchange;
  /** The route that produced it. */
  readonly route: Route;
  /** `1` on the original run, `2` on a resumed continuation. */
  readonly execution: HandlerExecution;
  /** Cut short when the route stops. */
  readonly signal: AbortSignal;
}

/**
 * What an exit handler may answer.
 *
 * A replacement body redacts or reshapes what leaves. It is applied AFTER
 * the route's declared output validation, so a redaction that drops a
 * required field is not reported against the route author's schema: the
 * contract the schema states is what the route produced, and this point is
 * what an operator decided may leave. A transport advertising that schema
 * therefore describes the route's output and not the redaction, which the
 * reference page says in as many words.
 */
export type ExitOutcome =
  { readonly body: unknown } | HeaderDecoration | RecoveryDrop;

/** A handler at the `admission` point. */
export type AdmissionHandler = (
  ctx: AdmissionContext,
) => AdmissionOutcome | undefined | Promise<AdmissionOutcome | undefined>;

/** A handler at the `entry` point. */
export type EntryHandler = (
  ctx: EntryContext,
) => EntryOutcome | undefined | Promise<EntryOutcome | undefined>;

/** A handler at the `exit` point. */
export type ExitHandler = (
  ctx: ExitContext,
) => ExitOutcome | undefined | Promise<ExitOutcome | undefined>;

/**
 * Merge one handler's header decoration onto what earlier handlers produced.
 *
 * Later keys win on a collision, which is registration order deciding, the
 * same rule the rest of the point runs on. The accumulation is what the
 * following handler sees, so two plugins each stamping their own header both
 * take effect.
 *
 * @internal
 */
export function mergeHeaderDecoration(
  carried: HeaderDecoration | undefined,
  decoration: HeaderDecoration,
): HeaderDecoration {
  return carried === undefined
    ? decoration
    : { headers: { ...carried.headers, ...decoration.headers } };
}

/**
 * Whether an answer is a header decoration.
 *
 * Structural rather than branded: `{ headers }` is the point's own
 * vocabulary and a handler writes the literal, so there is nothing to brand.
 * A drop directive is checked for first by the caller, so a `Recovery` never
 * reaches here.
 *
 * @internal
 */
export function isHeaderDecoration(
  answer: unknown,
): answer is HeaderDecoration {
  return (
    typeof answer === "object" &&
    answer !== null &&
    "headers" in answer &&
    typeof (answer as HeaderDecoration).headers === "object" &&
    (answer as HeaderDecoration).headers !== null
  );
}

/**
 * The headers a decoration contributes, as the exchange takes them.
 *
 * @internal
 */
export function decoratedHeaders(
  decoration: HeaderDecoration,
): Partial<ExchangeHeaders> {
  return decoration.headers as Partial<ExchangeHeaders>;
}
