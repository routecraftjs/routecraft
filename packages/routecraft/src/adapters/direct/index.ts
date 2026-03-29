import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Source } from "../../operations/from";
import type { Destination } from "../../operations/to";
import type {
  RegisteredDirectEndpoint,
  DirectEndpointRegistry,
  ResolveBody,
} from "../../registry";
import { DirectSourceAdapter } from "./source";
import { DirectDestinationAdapter } from "./destination";
import type {
  DirectEndpoint,
  DirectServerOptions,
  DirectClientOptions,
} from "./types";

/**
 * Creates a direct adapter for synchronous, in-process inter-route messaging.
 *
 * - **Source (for `.from()`):** Call with two arguments: `direct(endpoint, options)`. Pass `{}` for options if you need no schema/description. Body type is inferred from `options.schema` when provided.
 * - **Destination (for `.to()` / `.tap()`):** Call with one argument: `direct(endpoint)` or `direct((exchange) => endpointString)`.
 *
 * Semantics: single consumer per endpoint (last subscriber wins), blocking send (sender waits for response).
 *
 * @param endpoint - Endpoint name (string) or function (exchange) => endpoint string
 * @param options - Optional. If provided (even `{}`), returns a Source; if omitted or `undefined`, returns a Destination
 * @returns Source when options is provided; Destination when options is omitted
 *
 * @example
 * ```typescript
 * // Source route (server)
 * .from(direct('ingest', { schema: mySchema, description: 'Ingest API' }))
 *
 * // Destination (client)
 * .to(direct('ingest'))
 * .to(direct((ex) => ex.headers['x-endpoint'] as string))
 * ```
 */
export function direct<S extends StandardSchemaV1 | undefined = undefined>(
  endpoint: RegisteredDirectEndpoint,
  options: Partial<DirectServerOptions> & { schema?: S },
): Source<
  S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : unknown
>;
export function direct<K extends RegisteredDirectEndpoint>(
  endpoint: K,
): Destination<ResolveBody<DirectEndpointRegistry, K>, unknown>;
export function direct<T = unknown>(
  endpoint: DirectEndpoint<T>,
): Destination<T, T>;
export function direct<
  S extends StandardSchemaV1 | undefined = undefined,
  T = unknown,
>(
  endpoint: DirectEndpoint<T>,
  options?: (Partial<DirectServerOptions> | Partial<DirectClientOptions>) & {
    schema?: S;
  },
):
  | Source<
      S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : unknown
    >
  | Destination<T, T> {
  if (options !== undefined) {
    return new DirectSourceAdapter(
      endpoint as string,
      options as Partial<DirectServerOptions>,
    ) as Source<
      S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : unknown
    >;
  }
  return new DirectDestinationAdapter<T>(endpoint) as Destination<T, T>;
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
  sanitizeEndpoint,
} from "./shared";
export { directPlugin } from "./plugin";
