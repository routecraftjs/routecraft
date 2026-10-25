import { HeadersKeys, getExchangeRoute, type Exchange } from "../../exchange";
import { TRACE_PARENT_HEADER } from "../../trace-context";
import type { Source, Subscription } from "../../operations/from";
import { rcError } from "../../error";
import { registerInternalEndpoint } from "../../capabilities";
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

  /**
   * Subscribe the route's endpoint, and keep the registry honest about it.
   *
   * One rule, stated here rather than at each of the sites that keep it:
   * the registry entry (a capability, or an internal marker) is written
   * only once the subscription can actually answer, and is disposed on
   * every path that leaves nothing to answer it. A stopped route that
   * stayed listed was offered to agents and reported dispatchable by the
   * ops listing, and the dispatch that followed reached a channel with no
   * handler and failed RC5004.
   */
  async subscribe(sub: Subscription<T>): Promise<void> {
    const { context, meta } = sub;
    if (!meta?.routeId) {
      throw rcError("RC5003", undefined, {
        message:
          "DirectSourceAdapter requires a route id from the engine (missing SourceMeta.routeId)",
        suggestion:
          "Direct source adapters receive their endpoint name from the route id. This error indicates a harness or test is calling subscribe() without meta; pass { routeId: '<name>' }.",
      });
    }

    const endpoint = sanitizeEndpoint(meta.routeId);

    // Before registering: an aborted subscription returns below without a
    // handler, and would leave no unsubscribe to undo the entry.
    if (sub.signal.aborted) {
      context.logger.debug(
        { endpoint, adapter: "direct" },
        "Subscription aborted for direct endpoint",
      );
      return;
    }

    // Discovery speaks raw route ids; the sanitised key is only for the
    // channel map. An internal route registers its internal-ness INSTEAD
    // of a capability: the in-process endpoint below works unchanged,
    // while ops dispatch and directTool resolution find no capability and
    // can refuse by name.
    // The channel first: a configured `channelType` constructor can throw,
    // and a registry entry written before it would outlive a route that
    // never subscribed, which is the defect this whole path exists to stop.
    const channel = getDirectChannel<T>(context, endpoint, this.options);

    const unregister =
      this.options.internal === true
        ? registerInternalEndpoint(context, meta.routeId)
        : registerRoute(context, meta.routeId, meta.discovery);

    context.logger.debug(
      { endpoint, adapter: "direct" },
      "Setting up subscription for direct endpoint",
    );

    // Unwrap the channel's Exchange payload and hand body / headers to the
    // framework-provided handler. The caller's principal rides through on
    // `headers["routecraft.auth.principal"]` (the source of truth after
    // the state-model unification), so route-to-route invocations
    // preserve identity automatically: the called route's `.authorize()`
    // sees the same principal as the caller without a separate parameter.
    // Framework-level input validation runs inside the handler, so the
    // adapter has nothing more to do here.
    const wrappedHandler = async (exchange: Exchange<T>) => {
      const result = await sub.emit({
        message: exchange.body as T,
        headers: withCause(exchange),
      });
      return result as Exchange<T>;
    };

    // Wired before subscribing, so an abort landing mid-setup is caught.
    sub.signal.addEventListener(
      "abort",
      () => {
        unregister();
        channel.unsubscribe(context, endpoint).catch((err) => {
          context.logger.error(
            { err, adapter: "direct", endpoint, operation: "unsubscribe" },
            "Failed to unsubscribe from direct endpoint during abort",
          );
        });
      },
      { once: true },
    );

    // Roll the registration back if the channel refuses the handler.
    try {
      await channel.subscribe(context, endpoint, wrappedHandler);
    } catch (error: unknown) {
      unregister();
      throw error;
    }

    sub.ready();

    // Keep the route "running" until the context stops (abort). Otherwise the context
    // would see all routes complete and auto-stop, e.g. before MCP can serve tool calls.
    await new Promise<void>((resolve) => {
      if (sub.signal.aborted) {
        resolve();
        return;
      }
      sub.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }
}

/**
 * The headers a direct call hands the target's ingress: the caller's, with
 * the caller recorded as the cause.
 *
 * What arrives over the channel is either a live exchange of some route (a
 * `direct()` destination's caller, or a `forward()` from one), which is the
 * cause, or an envelope built outside any route (`CraftClient.sendDirect`, an
 * agent tool's dispatch, a `.tap()` snapshot), whose own id names nothing
 * that ran, so the causation id it was built with is kept.
 */
function withCause<T>(exchange: Exchange<T>) {
  if (getExchangeRoute(exchange) === undefined) return exchange.headers;
  // Omitted, not deleted: `delete` drops the header bag into dictionary mode.
  // The adopted remote parent belongs to the exchange its door built; the
  // callee's parent span is its caller's, reached through the causation id.
  const headers: Record<string, unknown> = {};
  for (const key of Object.keys(exchange.headers)) {
    if (key !== TRACE_PARENT_HEADER) headers[key] = exchange.headers[key];
  }
  headers[HeadersKeys.CAUSATION_ID] = exchange.id;
  return headers as typeof exchange.headers;
}
