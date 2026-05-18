import type { Exchange } from "../../exchange";
import type { Destination } from "../../operations/to";
import type { DirectEndpoint, DirectClientOptions } from "./types";
import { getDirectChannel, sanitizeEndpoint } from "./shared";

/**
 * DirectDestinationAdapter implements the Destination interface for the direct adapter.
 *
 * This adapter is used when direct() is called with one argument:
 * - `direct(endpoint)` where endpoint is a string
 * - `direct((exchange) => endpoint)` where endpoint is a function
 *
 * It sends messages to a specific endpoint (static or dynamic).
 *
 * The two generics model the in-process request/response shape: `TIn` is the
 * body type the caller sends, `TOut` is the body type the target route
 * returns. They default to being equal for backwards compatibility with the
 * symmetric `Destination<T, T>` overload of `direct()`.
 */
export class DirectDestinationAdapter<
  TIn = unknown,
  TOut = TIn,
> implements Destination<TIn, TOut> {
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

  async send(exchange: Exchange<TIn>): Promise<TOut> {
    // Import dynamically to avoid circular dependency
    const { getExchangeContext } = await import("../../exchange");
    const context = getExchangeContext(exchange);
    if (!context) {
      throw new Error("Exchange has no context; cannot send via direct");
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
  }

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
