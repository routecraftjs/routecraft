import type { Exchange } from "../../exchange";
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
 *   Works with both string and function endpoints. When
 *   `DirectEndpointRegistry` is populated, the endpoint string is still
 *   constrained to registered keys.
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
 * .transform((b) => ({ name: b.agent, query: b.text }))
 * .enrich(direct<{ name: string; query: string }, AgentResult>("agent"))
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
/**
 * Destination with explicit input and output body types. Use when the
 * target route's response body shape differs from the caller's input
 * shape (e.g. an in-process agent or RPC-style call). Accepts a string
 * endpoint (constrained to registered keys when `DirectEndpointRegistry`
 * is populated) or a function endpoint resolved from the exchange.
 *
 *   actually returns a value matching `TOut`. The caller asserts the
 *   output shape. A future release may require a matching
 *   `.output({ body: schema })` on the callee and validate the response
 *   automatically; until then, treat `TOut` as a caller-side assertion
 *   rather than a framework-enforced contract.
 */
export function direct<TIn, TOut>(
  endpoint: RegisteredDirectEndpoint | ((exchange: Exchange<TIn>) => string),
): Destination<TIn, TOut>;
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
