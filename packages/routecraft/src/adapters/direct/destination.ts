import type { Exchange } from "../../exchange";
import type { Destination } from "../../operations/to";
import type { CraftContext, MergedOptions } from "../../context";
import type { DirectEndpoint, DirectClientOptions } from "./types";
import type { DirectOptionsMerged } from "./shared";
import { getDirectChannel, getMergedOptions, sanitizeEndpoint } from "./shared";

/**
 * DirectDestinationAdapter implements the Destination interface for the direct adapter.
 *
 * This adapter is used when direct() is called with one argument:
 * - `direct(endpoint)` where endpoint is a string
 * - `direct((exchange) => endpoint)` where endpoint is a function
 *
 * It sends messages to a specific endpoint (static or dynamic).
 */
export class DirectDestinationAdapter<T = unknown>
  implements Destination<T, T>, MergedOptions<DirectOptionsMerged>
{
  readonly adapterId: string = "routecraft.adapter.direct";

  private rawEndpoint: DirectEndpoint<T>;
  public options: Partial<DirectOptionsMerged>;
  private lastResolvedEndpoint?: string;

  constructor(
    rawEndpoint: DirectEndpoint<T>,
    options: Partial<DirectClientOptions> = {},
  ) {
    this.rawEndpoint = rawEndpoint;
    this.options = options as Partial<DirectOptionsMerged>;
  }

  async send(exchange: Exchange<T>): Promise<T> {
    // Import dynamically to avoid circular dependency
    const { getExchangeContext } = await import("../../exchange");
    const context = getExchangeContext(exchange);
    if (!context) {
      throw new Error("Exchange has no context — cannot send via direct");
    }

    // Resolve endpoint dynamically if needed
    const endpoint = this.resolveEndpoint(exchange);
    this.lastResolvedEndpoint = endpoint; // Store for metadata

    exchange.logger.debug(
      { endpoint, adapter: "direct" },
      "Preparing to send message to direct endpoint",
    );

    const channel = getDirectChannel<T>(context, endpoint, this.options);

    // Send and wait for result - this is synchronous blocking behavior
    const result = await channel.send(endpoint, exchange);

    // Return the body from the result exchange
    return result.body;
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

  mergedOptions(context: CraftContext): DirectOptionsMerged {
    return getMergedOptions(context, this.options);
  }

  private resolveEndpoint(exchange: Exchange<T>): string {
    const endpoint =
      typeof this.rawEndpoint === "function"
        ? this.rawEndpoint(exchange)
        : this.rawEndpoint;
    return sanitizeEndpoint(endpoint);
  }
}
