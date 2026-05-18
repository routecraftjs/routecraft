import type { Source } from "../../operations/from";
import type { Destination } from "../../operations/to";
import type {
  RegisteredDirectEndpoint,
  DirectEndpointRegistry,
  ResolveBody,
} from "../../registry";
import { DirectSourceAdapter } from "./source";
import { DirectDestinationAdapter } from "./destination";
import type { DirectEndpoint, DirectServerOptions } from "./types";

/**
 * Creates a direct adapter for synchronous, in-process inter-route messaging.
 *
 * - **Source (for `.from()`):** Call with channel options (currently only
 *   `channelType`) or with no arguments. The endpoint is always the route id;
 *   discoverable metadata (title, description, input, output) lives on the
 *   route via `.title()`, `.description()`, `.input()`, `.output()`.
 * - **Destination (for `.to()` / `.tap()`):** Call with a string or function
 *   naming the target route: `direct("fetch-order")` or
 *   `direct((exchange) => exchange.headers["x-endpoint"] as string)`.
 * - **Destination with explicit input/output types:** Supply two type
 *   arguments to express a route whose response body shape differs from
 *   the caller's input shape, e.g. `direct<ChatInput, AgentResult>("agent")`.
 *
 * Semantics: single consumer per endpoint (last subscriber wins), blocking
 * send (sender waits for response).
 *
 * @example
 * ```ts
 * // Source route (endpoint = route id)
 * craft()
 *   .id("ingest")
 *   .title("Ingest API")
 *   .description("Accept ingest payloads")
 *   .input({ body: mySchema })
 *   .from(direct())
 *
 * // Agent-only source (no id -> UUID endpoint, not callable from code)
 * craft()
 *   .description("Internal knowledge base lookup")
 *   .input({ body: querySchema })
 *   .from(direct())
 *
 * // Destination
 * .to(direct("ingest"))
 * .to(direct((ex) => ex.headers["x-endpoint"] as string))
 *
 * // Destination with input != output (e.g. in-process agent call)
 * .transform((b) => ({ name: b.agent, body: b.text }))
 * .enrich(direct<{ name: string; body: string }, AgentResult>("agent"))
 * ```
 */
export function direct(options: DirectServerOptions): Source<unknown>;
export function direct(): Source<unknown>;
export function direct<K extends RegisteredDirectEndpoint>(
  endpoint: K,
): Destination<ResolveBody<DirectEndpointRegistry, K>, unknown>;
export function direct<T = unknown>(
  endpoint: DirectEndpoint<T>,
): Destination<T, T>;
export function direct<TIn, TOut>(endpoint: string): Destination<TIn, TOut>;
export function direct<TIn = unknown, TOut = TIn>(
  arg?: DirectEndpoint<TIn> | DirectServerOptions,
): Source<unknown> | Destination<TIn, TOut> {
  // String or function first-arg -> Destination (names a target route).
  if (typeof arg === "string" || typeof arg === "function") {
    return new DirectDestinationAdapter<TIn, TOut>(arg);
  }
  // Undefined or options object -> Source (endpoint resolved from route id).
  return new DirectSourceAdapter(arg ?? {}) as Source<unknown>;
}

// Re-export types for public API
export type {
  DirectChannel,
  DirectChannelType,
  DirectEndpoint,
  DirectRouteMetadata,
  DirectBaseOptions,
  DirectServerOptions,
  DirectClientOptions,
  DirectOptions,
} from "./types";

// Re-export constants for registry access
export {
  ADAPTER_DIRECT_STORE,
  ADAPTER_DIRECT_OPTIONS,
  ADAPTER_DIRECT_REGISTRY,
  getDirectChannel,
  sanitizeEndpoint,
} from "./shared";
