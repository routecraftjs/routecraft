import { type ExchangeHeaders, type Exchange } from "../../exchange";
import type { Source, SourceMeta } from "../../operations/from";
import type { CraftContext } from "../../context";
import { rcError } from "../../error";
import type { DirectServerOptions } from "./types";
import { getDirectChannel, registerRoute, sanitizeEndpoint } from "./shared";

/**
 * DirectSourceAdapter implements the Source interface for the direct adapter.
 *
 * The endpoint name is the route id: there is no explicit endpoint option.
 * A route without `.id()` falls back to the builder's UUID id, which is by
 * design an agent-only capability (code cannot reference it as a destination,
 * but the registry still exposes it for discovery).
 *
 * This adapter is pure mechanism: input / output validation and discovery
 * metadata live on the route via `.title()` / `.description()` / `.input()` /
 * `.output()` and are handled by the framework.
 */
export class DirectSourceAdapter<T = unknown> implements Source<T> {
  readonly adapterId: string = "routecraft.adapter.direct";

  public options: DirectServerOptions;

  constructor(options: DirectServerOptions = {}) {
    this.options = options;
  }

  async subscribe(
    context: CraftContext,
    handler: (message: T, headers?: ExchangeHeaders) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
    meta?: SourceMeta,
  ): Promise<void> {
    if (!meta?.routeId) {
      throw rcError("RC5003", undefined, {
        message:
          "DirectSourceAdapter requires a route id from the engine (missing SourceMeta.routeId)",
        suggestion:
          "Direct source adapters receive their endpoint name from the route id. This error indicates a harness or test is calling subscribe() without meta; pass { routeId: '<name>' }.",
      });
    }

    const endpoint = sanitizeEndpoint(meta.routeId);

    registerRoute(context, endpoint, meta.discovery);

    context.logger.debug(
      { endpoint, adapter: "direct" },
      "Setting up subscription for direct endpoint",
    );

    const channel = getDirectChannel<T>(context, endpoint, this.options);

    if (abortController.signal.aborted) {
      context.logger.debug(
        { endpoint, adapter: "direct" },
        "Subscription aborted for direct endpoint",
      );
      return;
    }

    // Unwrap the channel's Exchange payload and hand body / headers to the
    // framework-provided handler. Framework-level input validation runs
    // inside that handler, so adapter has nothing more to do here.
    const wrappedHandler = async (exchange: Exchange<T>) => {
      const result = await handler(exchange.body as T, exchange.headers);
      return result as Exchange<T>;
    };

    // Set up cleanup on abort before subscribing
    abortController.signal.addEventListener(
      "abort",
      () => {
        channel.unsubscribe(context, endpoint).catch((err) => {
          context.logger.error(
            { err, adapter: "direct", endpoint, operation: "unsubscribe" },
            "Failed to unsubscribe from direct endpoint during abort",
          );
        });
      },
      { once: true },
    );

    // Set up the subscription
    await channel.subscribe(context, endpoint, wrappedHandler);

    onReady?.();

    // Keep the route "running" until the context stops (abort). Otherwise the context
    // would see all routes complete and auto-stop, e.g. before MCP can serve tool calls.
    await new Promise<void>((resolve) => {
      if (abortController.signal.aborted) {
        resolve();
        return;
      }
      abortController.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }
}
