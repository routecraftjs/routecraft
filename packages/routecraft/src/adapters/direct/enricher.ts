import type { Exchange } from "../../exchange";
import type { Enricher } from "../../operations/enrich.ts";
import type { DirectEndpoint, DirectClientOptions } from "./types";
import { getDirectChannel, sanitizeEndpoint } from "./shared";

/**
 * DirectEnricherAdapter implements the Enricher (fetch) role for the direct
 * adapter: an in-process request/response is a pull-in (the caller blocks on
 * the target route and receives its response body).
 *
 * This adapter is used when direct() is called with one argument:
 * - `direct(endpoint)` where endpoint is a string
 * - `direct((exchange) => endpoint)` where endpoint is a function
 *
 * The two generics model the in-process request/response shape: `TIn` is the
 * body type the caller sends, `TOut` is the body type the target route
 * returns. They default to being equal for backwards compatibility with the
 * symmetric `Enricher<T, T>` overload of `direct()`.
 */
export class DirectEnricherAdapter<
  TIn = unknown,
  TOut = TIn,
> implements Enricher<TIn, TOut> {
  readonly adapterId: string = "routecraft.adapter.direct";

  private rawEndpoint: DirectEndpoint<TIn>;
  public options: DirectClientOptions;
  private lastResolvedEndpoint?: string;

  constructor(
    rawEndpoint: DirectEndpoint<TIn>,
    options: DirectClientOptions = {},
  ) {
    this.rawEndpoint = rawEndpoint;
    this.options = options;
  }

  fetch = async (exchange: Exchange<TIn>): Promise<TOut> => {
    // Import dynamically to avoid circular dependency
    const { getExchangeContext } = await import("../../exchange");
    const context = getExchangeContext(exchange);
    if (!context) {
      throw new Error("Exchange has no context; cannot call direct endpoint");
    }

    // Resolve endpoint dynamically if needed
    const endpoint = this.resolveEndpoint(exchange);
    this.lastResolvedEndpoint = endpoint; // Store for metadata

    exchange.logger.debug(
      { endpoint, adapter: "direct" },
      "Preparing to send message to direct endpoint",
    );

    const channel = getDirectChannel<TIn>(context, endpoint, this.options);

    // Send and wait for result - this is synchronous blocking behavior
    const result = await channel.send(endpoint, exchange);

    // The wire-level channel is body-symmetric, but the consumer route may
    // produce a body whose shape differs from the caller's input. That shape
    // is opaque to this adapter at compile time, so we widen here.
    return result.body as unknown as TOut;
  };

  /**
   * Extract metadata from Direct adapter execution.
   * Includes the resolved endpoint.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getMetadata(_result?: unknown): Record<string, unknown> {
    return {
      endpoint: this.lastResolvedEndpoint ?? "unknown",
    };
  }

  private resolveEndpoint(exchange: Exchange<TIn>): string {
    const endpoint =
      typeof this.rawEndpoint === "function"
        ? this.rawEndpoint(exchange)
        : this.rawEndpoint;
    return sanitizeEndpoint(endpoint);
  }
}
