import type { Adapter, Step, StepOutcome } from "../types.ts";
import {
  type Exchange,
  HeadersKeys,
  OperationType,
  getExchangeContext,
  restampExchange,
  routeIdOf,
} from "../exchange.ts";
import { lineageOf } from "../lineage.ts";
import { assertTraceId } from "../trace-context.ts";
import { JOINED_HEADER } from "../journey-headers.ts";
import { rcError } from "../error.ts";

/**
 * Where an exchange belongs: the journey it continues and the exchange that
 * caused it. A field left out keeps the exchange's current value.
 */
export interface Correlation {
  /** The correlation id of the journey to join. */
  readonly correlationId?: string;
  /** The `routecraft.id` of the exchange that caused this one. */
  readonly causationId?: string;
}

/**
 * Computes where the exchange belongs. A falsy result (`undefined`, `null`,
 * `false`) leaves the exchange as it is, so a lookup that found nothing reads
 * as `found && { correlationId: found.correlationId }`.
 *
 * @template T - Body type of the exchange
 */
export type CallableCorrelator<T = unknown> = (
  exchange: Exchange<T>,
) =>
  | Correlation
  | undefined
  | null
  | false
  | Promise<Correlation | undefined | null | false>;

/**
 * Correlator adapter: the function `.correlate()` runs.
 *
 * @template T - Body type
 */
export interface Correlator<T = unknown> extends Adapter {
  correlate: CallableCorrelator<T>;
}

/**
 * Step that re-stamps an exchange onto another journey, for a channel that
 * cannot carry the trace context itself (a webhook back from GitHub, a reply
 * by mail). The application looks up where the artefact came from; this step
 * joins the exchange to it.
 *
 * It changes the correlation and causation ids together with everything that
 * reads them, which is why `.header()` refuses both keys: the exchange's
 * logger is rebound, its lineage entry reports the new cause, and
 * `route:exchange:correlated` records the old and new ids, so a ledger sees
 * the stitch as an edge rather than a silent rewrite. Events emitted before
 * the step carry the old ids. The in-process parent the `event()` guard walks
 * is not re-stamped, so a route still recognises its own work after the
 * stitch. A new correlation id marks the exchange as having joined its
 * journey (`isJoinedJourney`): it came from data, so nothing that reaches a
 * particular person by correlation id trusts it.
 *
 * A supplied id that is not well formed fails the step with `RC5003`: it came
 * from the route's own code.
 */
export class CorrelateStep<T = unknown> implements Step<Correlator<T>> {
  operation: OperationType = OperationType.CORRELATE;
  adapter: Correlator<T>;

  constructor(correlate: CallableCorrelator<T>) {
    this.adapter = { correlate };
  }

  async execute(exchange: Exchange<T>): Promise<StepOutcome> {
    const context = getExchangeContext(exchange);
    if (context === undefined) {
      throw rcError("RC5003", undefined, {
        message:
          "A .correlate() step ran on an exchange bound to no context; it can only re-stamp an exchange a route is running.",
      });
    }
    const found = await Promise.resolve(this.adapter.correlate(exchange));
    if (!found) return { kind: "continue", exchange };
    const site = "A .correlate() step";
    if (found.correlationId !== undefined) {
      assertTraceId(found.correlationId, "correlation id", site);
    }
    if (found.causationId !== undefined) {
      assertTraceId(found.causationId, "causation id", site);
    }
    const previousCorrelation = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    const previousCause = exchange.headers[HeadersKeys.CAUSATION_ID] as
      string | undefined;
    const correlationId = found.correlationId ?? previousCorrelation;
    const causationId = found.causationId ?? previousCause;
    if (
      correlationId === previousCorrelation &&
      causationId === previousCause
    ) {
      return { kind: "continue", exchange };
    }
    const joined = correlationId !== previousCorrelation;
    const next = restampExchange(exchange, {
      ...exchange.headers,
      [HeadersKeys.CORRELATION_ID]: correlationId,
      ...(causationId !== undefined
        ? { [HeadersKeys.CAUSATION_ID]: causationId }
        : {}),
      // A correlation id taken from data is a claim; see `isJoinedJourney`.
      ...(joined ? { [JOINED_HEADER]: "correlate" } : {}),
    });
    lineageOf(context).recause(exchange.id, causationId, joined);
    context.emit("route:exchange:correlated", {
      routeId: routeIdOf(exchange),
      exchangeId: exchange.id,
      correlationId,
      ...(causationId !== undefined ? { causationId } : {}),
      previous: {
        correlationId: previousCorrelation,
        ...(previousCause !== undefined ? { causationId: previousCause } : {}),
      },
    });
    next.logger.debug(
      {
        previousCorrelationId: previousCorrelation,
        ...(previousCause !== undefined
          ? { previousCausationId: previousCause }
          : {}),
      },
      "Exchange journey re-stamped",
    );
    return { kind: "continue", exchange: next };
  }
}
