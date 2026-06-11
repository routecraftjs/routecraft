import { randomUUID } from "node:crypto";
import {
  type Adapter,
  type Step,
  getAdapterLabel,
  type StepOutcome,
} from "../types.ts";
import { INTERNALS_KEY } from "../brand.ts";
import {
  type Exchange,
  type ExchangeHeaders,
  OperationType,
  HeadersKeys,
  DefaultExchange,
  getExchangeContext,
  getExchangeRoute,
  EXCHANGE_INTERNALS,
} from "../exchange.ts";
import type { Route } from "../route.ts";

/**
 * Store key for the map of split group IDs to their parent exchanges.
 * Used by the aggregate step to restore the parent exchange identity
 * after merging children.
 */
export const SPLIT_PARENT_STORE = "routecraft.split.parents" as const;

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [SPLIT_PARENT_STORE]: Map<string, Exchange>;
  }
}

/**
 * Brand key marking a {@link SplitChild} envelope. `Symbol.for` so envelopes
 * survive crossing duplicate copies of the package (CLI vs user module).
 */
const SPLIT_CHILD = Symbol.for("routecraft.split.child");

/**
 * Per-child envelope produced by {@link splitChild}: a body plus optional
 * header OVERRIDES for that child. The brand makes the envelope
 * unambiguous -- a split item that happens to have a `body` property is
 * still treated as a plain body unless it went through `splitChild`.
 *
 * @template R - Body type of the child
 */
export interface SplitChild<R = unknown> {
  readonly [SPLIT_CHILD]: true;
  readonly body: R;
  readonly headers?: ExchangeHeaders;
}

/**
 * Wrap one split child with per-child header overrides. Plain return values
 * from a splitter become child bodies that inherit the parent's headers;
 * use this helper only when a child needs its own header values on top.
 *
 * @example
 * ```ts
 * .split((exchange) =>
 *   exchange.body.lines.map((line, i) => splitChild(line, { "x-line": i })),
 * )
 * ```
 */
export function splitChild<R>(
  body: R,
  headers?: ExchangeHeaders,
): SplitChild<R> {
  return headers === undefined
    ? { [SPLIT_CHILD]: true, body }
    : { [SPLIT_CHILD]: true, body, headers };
}

/** Type guard for {@link SplitChild} envelopes. */
export function isSplitChild(value: unknown): value is SplitChild {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[SPLIT_CHILD] === true
  );
}

/**
 * What a splitter produces per child: the child's body, or a
 * {@link splitChild} envelope when the child needs header overrides. The
 * FRAMEWORK constructs the child exchanges (fresh id, parent headers
 * inherited, `routecraft.split_hierarchy` maintained); splitters never
 * build `Exchange` instances themselves.
 *
 * @template R - Body type of the child
 */
export type SplitResult<R = unknown> = R | SplitChild<R>;

/**
 * Function form of a splitter: takes the current exchange and returns the
 * child bodies (or {@link splitChild} envelopes). Use with
 * `.split(splitter)` or no-arg `.split()` for arrays.
 *
 * @template T - Current body type
 * @template R - Body type of each child
 */
export type CallableSplitter<T = unknown, R = unknown> = (
  exchange: Exchange<T>,
) => Promise<Array<SplitResult<R>>> | Array<SplitResult<R>>;

/**
 * Splitter adapter: turns one body into many; each item is processed as a separate exchange.
 * Used with `.split()`. Default (no adapter): array bodies are split into elements; non-arrays become one item.
 *
 * @template T - Current body type
 * @template R - Item type
 */
export interface Splitter<T = unknown, R = unknown> extends Adapter {
  split: CallableSplitter<T, R>;
}

/**
 * Step that splits the exchange into multiple exchanges (e.g. one per array element).
 * Each new exchange gets a new id and shared split hierarchy for aggregation.
 * Framework maintains `routecraft.split_hierarchy` headers for aggregation.
 */
export class SplitStep<T = unknown, R = unknown> implements Step<
  Splitter<T, R>
> {
  operation: OperationType = OperationType.SPLIT;
  adapter: Splitter<T, R>;
  skipStepEvents = true;

  constructor(adapter: Splitter<T, R> | CallableSplitter<T, R>) {
    this.adapter = typeof adapter === "function" ? { split: adapter } : adapter;
  }

  async execute(exchange: Exchange<T>): Promise<StepOutcome> {
    const context = getExchangeContext(exchange);
    const route = getExchangeRoute(exchange);

    if (!context) {
      throw new Error("Exchange has no context; cannot execute split");
    }

    const routeId =
      route?.definition.id ??
      (exchange.headers[HeadersKeys.ROUTE_ID] as string);
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    const adapterLabel = getAdapterLabel(this.adapter);
    const stepStart = Date.now();

    context.emit("route:step:started", {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      operation: this.operation,
      ...(adapterLabel ? { adapter: adapterLabel } : {}),
    });

    let splitResults: Array<SplitResult<R>>;
    try {
      splitResults = await Promise.resolve(this.adapter.split(exchange));
    } catch (error: unknown) {
      context.emit("route:step:failed", {
        routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: this.operation,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
        duration: Date.now() - stepStart,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const groupId = randomUUID();

    // Stash the parent exchange so aggregate can restore it
    let parentMap = context.getStore(SPLIT_PARENT_STORE) as
      | Map<string, Exchange>
      | undefined;
    if (!parentMap) {
      parentMap = new Map<string, Exchange>();
      context.setStore(SPLIT_PARENT_STORE, parentMap);
    }
    parentMap.set(groupId, exchange);

    const existingHierarchy =
      (exchange.headers[HeadersKeys.SPLIT_HIERARCHY] as string[]) || [];
    const splitHierarchy = [...existingHierarchy, groupId];

    const children: Exchange<R>[] = [];
    for (const result of splitResults) {
      const envelope = isSplitChild(result)
        ? (result as SplitChild<R>)
        : undefined;
      const childBody = envelope ? envelope.body : (result as R);
      // Spread parent headers first so cross-cutting concerns
      // (`routecraft.auth.principal`, future tracing/tenancy keys) flow
      // through to every child. A `splitChild` envelope's headers override
      // on collision; the framework assigns the fresh id and the
      // split-hierarchy slot last.
      const postProcessedExchange = new DefaultExchange<R>(context, {
        body: childBody,
        headers: {
          ...exchange.headers,
          ...(envelope?.headers ?? {}),
          [HeadersKeys.ID]: randomUUID(),
          [HeadersKeys.SPLIT_HIERARCHY]: splitHierarchy,
        },
      });

      // Set route in internals if it exists (symbol-key for cross-instance)
      if (route) {
        const internals =
          (
            postProcessedExchange as unknown as Exchange & {
              [key: symbol]: { context: unknown; route?: Route };
            }
          )[INTERNALS_KEY] ?? EXCHANGE_INTERNALS.get(postProcessedExchange);
        if (internals) {
          internals.route = route as Route;
        }
      }

      const adapterLabel = getAdapterLabel(this.adapter);
      postProcessedExchange.logger.debug(
        {
          operation: "split",
          ...(adapterLabel ? { adapter: adapterLabel } : {}),
          splitHierarchy:
            postProcessedExchange.headers[HeadersKeys.SPLIT_HIERARCHY],
        },
        "Emitting split child exchange",
      );
      children.push(postProcessedExchange);
    }

    context.emit("route:step:completed", {
      routeId,
      exchangeId: exchange.id,
      correlationId,
      operation: this.operation,
      ...(adapterLabel ? { adapter: adapterLabel } : {}),
      duration: Date.now() - stepStart,
      metadata: { childCount: splitResults.length },
    });

    return { kind: "fanOut", exchanges: children };
  }
}
