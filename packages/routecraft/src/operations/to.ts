import {
  type Adapter,
  type Step,
  type StepContext,
  type StepOutcome,
  type StepSignalContext,
  extractOutcomeMetadata,
  toSignalContext,
} from "../types.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  type HeaderValue,
  OperationType,
  getExchangeContext,
  DefaultExchange,
} from "../exchange.ts";
import type { Enricher, CallableEnricher } from "./enrich.ts";
import { hasSend, hasFetch, missingSlotError } from "./adapter-roles.ts";
import { engineOwnedHeaderSuggestion } from "../engine-headers.ts";
import {
  resolveAdapterOverride,
  invokeSendOverride,
} from "../testing-hooks.ts";
import { SUSPEND_HOST } from "../dsl-symbol.ts";
import type { SuspendCapableStep, SuspendSite } from "../suspension/sites.ts";
import { convertSuspendSignal, isSuspendSignal } from "../suspension/signal.ts";

/**
 * Context handed to a destination's `send`. Extends the abort surface with a
 * header sink: a send that produces a receipt (a message id, an etag, a
 * created-resource URL) surfaces it by calling `setHeader`, and the `.to()`
 * step merges the collected headers onto the continuing exchange. The body is
 * never touched by a send; receipts ride headers, results ride `fetch`.
 *
 * `.tap()` also provides the sink, but the tap runs against a detached
 * snapshot, so headers set there are discarded with it.
 *
 * The parameter is optional at the call site (adapters invoked directly in
 * tests may omit it), so implementations should guard: `ctx?.setHeader(...)`.
 */
export interface SendContext extends StepSignalContext {
  /** Record a receipt header to merge onto the continuing exchange. */
  setHeader(key: string, value: HeaderValue): void;
}

/**
 * Function form of a destination: receives the exchange and performs a side
 * effect. Strictly void: a returned value is not a body replacement (use an
 * {@link Enricher} or `.enrich()` when the step should produce data).
 *
 * The second argument carries the step's {@link SendContext}: `signal` aborts
 * when an enclosing `.timeout()` expires (forward it into cancellation-aware
 * IO), and `setHeader` records receipt headers for the continuing exchange.
 * Declaring only the first parameter remains valid.
 *
 * @template T - Current body type
 */
export type CallableDestination<T = unknown> = (
  exchange: Exchange<T>,
  ctx?: SendContext,
) => Promise<void> | void;

/**
 * Destination adapter: pushes the exchange OUT to an external system (HTTP
 * call, queue, file write, SMTP send). Used with `.to()` and `.tap()`.
 *
 * `send` is strictly void: the body flows through a `.to()` step unchanged.
 * A send that produces a receipt surfaces it via `ctx.setHeader` (see
 * {@link SendContext}); an adapter whose purpose is to PRODUCE data
 * implements {@link Enricher} instead (or additionally).
 *
 * @template T - Current body type
 */
export interface Destination<T = unknown> extends Adapter {
  send: CallableDestination<T>;
}

/**
 * Anything `.to()` accepts: a Destination (send wins when both slots exist),
 * an Enricher (fetch-only pull-in; the result replaces the body), or a
 * function form routed by its inferred return type.
 *
 * @template T - Current body type
 * @template R - Fetch result type for the enricher / function forms
 */
export type ToTarget<T = unknown, R = unknown> =
  | Destination<T>
  | Enricher<T, R>
  | CallableDestination<T>
  | CallableEnricher<T, R>;

/**
 * Step that hands the exchange to a destination or enricher.
 *
 * Resolution follows the role model: an adapter with `send` is invoked as a
 * push-out and the body continues unchanged (receipt headers from the
 * {@link SendContext} sink are merged on); an adapter with only `fetch` is
 * invoked as a pull-in and the result replaces the body. Function forms are
 * invoked directly: a returned value (other than `undefined`) replaces the
 * body, mirroring the static send/fetch split on the inferred return type.
 */
export class ToStep<T = unknown, R = unknown>
  implements Step<Adapter>, SuspendCapableStep
{
  operation: OperationType = OperationType.TO;
  adapter: Adapter;
  /** Assigned by the suspend-site walk when the adapter is suspend-capable. */
  suspendSite?: SuspendSite;
  /** Why the walk refused a site (fan-out or sealed side flow), when it did. */
  suspendRefusal?: string;
  /** Function form, when constructed from a bare callable. */
  private readonly callable: CallableEnricher<T, R | void> | undefined;

  /** This step hosts its own suspend site; wrappers forward here. @internal */
  [SUSPEND_HOST](): SuspendCapableStep {
    return this;
  }

  constructor(target: ToTarget<T, R>) {
    if (typeof target === "function") {
      this.callable = target as CallableEnricher<T, R | void>;
      this.adapter = { send: target } as Adapter;
    } else {
      this.callable = undefined;
      this.adapter = target;
    }
  }

  async execute(
    exchange: Exchange<T>,
    ctx?: StepContext,
  ): Promise<StepOutcome> {
    // Resolve a test-time override (if any) registered on the context.
    // When present, the mock handler stands in for the adapter; if the mock
    // has no handler, the call is silently swallowed (a noop destination).
    const override = resolveAdapterOverride(
      this.adapter,
      getExchangeContext(exchange),
      "send",
    );

    const receiptHeaders: Record<string, HeaderValue> = {};
    const sendContext: SendContext = {
      ...toSignalContext(ctx),
      setHeader: (key, value) => {
        // Receipts are merged onto the continuing exchange, so the sink has
        // to respect the same engine-owned keys `.header()` rejects: a
        // receipt landing on `routecraft.route` or `.split_hierarchy` would
        // misattribute events or break split correlation. `.header()` can
        // throw because it validates at construction; here the send has
        // already happened, so failing the step would be worse than dropping
        // the header. Warn loudly and ignore.
        const suggestion = engineOwnedHeaderSuggestion(key);
        if (suggestion !== undefined) {
          exchange.logger.warn(
            { header: key, adapter: this.adapter.adapterId, suggestion },
            "Adapter tried to set a framework-owned header as a send receipt; ignoring",
          );
          return;
        }
        receiptHeaders[key] = value;
      },
    };

    let result: unknown;
    let sendResolved = false;
    try {
      if (override) {
        result = await invokeSendOverride(exchange, this.adapter, override);
        // A mocked send stays a send: the body continues unchanged even if
        // the mock returned a value. Only fetch-resolved calls replace it.
        if (!this.callable && hasSend<T>(this.adapter)) {
          result = undefined;
        }
      } else if (this.callable) {
        result = await Promise.resolve(this.callable(exchange, sendContext));
      } else if (hasSend<T>(this.adapter)) {
        sendResolved = true;
        await Promise.resolve(this.adapter.send(exchange, sendContext));
        result = undefined;
      } else if (hasFetch<T, R>(this.adapter)) {
        result = await Promise.resolve(
          this.adapter.fetch(exchange, toSignalContext(ctx)),
        );
      } else {
        throw missingSlotError("`.to()`");
      }
    } catch (err) {
      // Converted here, inside the step, so a step-scope wrapper never
      // observes the raw throw (a retry wrapper would re-run the adapter
      // and charge the parked work twice).
      if (isSuspendSignal(err)) {
        return convertSuspendSignal(this, exchange, err);
      }
      throw err;
    }

    const collectedHeaders = Object.keys(receiptHeaders).length
      ? receiptHeaders
      : undefined;

    // The metadata rides the OUTCOME, not the step: Step instances are
    // shared across exchanges. The two slots have distinct hooks: a
    // fetch-resolved call hands its result to `getMetadata`, a
    // send-resolved call hands its receipt-header record (or undefined
    // when no receipts were set) to `getSendMetadata`.
    const metadata = sendResolved
      ? extractOutcomeMetadata(
          this.adapter,
          collectedHeaders,
          !!override,
          "getSendMetadata",
          exchange,
        )
      : extractOutcomeMetadata(
          this.adapter,
          result,
          !!override,
          "getMetadata",
          exchange,
        );

    // A fetch result (or a value returned from a function form) replaces the
    // body via a derived exchange; receipt headers from a send are merged the
    // same way. The original is frozen, so a new wrapper preserves identity
    // and internals via rewrap.
    let next: Exchange<unknown> = exchange;
    if (result !== undefined || collectedHeaders) {
      next = DefaultExchange.rewrap<unknown>(exchange, {
        ...(result !== undefined ? { body: result } : {}),
        ...(collectedHeaders
          ? {
              headers: {
                ...exchange.headers,
                ...collectedHeaders,
              } as ExchangeHeaders,
            }
          : {}),
      });
    }

    return {
      kind: "continue",
      exchange: next,
      ...(metadata ? { metadata } : {}),
    };
  }
}
