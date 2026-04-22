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
 * - **Source (for `.from()`):** Call with two arguments: `direct(endpoint, options)`. Pass `{}` for options if you need no schemas. Body type is inferred from `options.input.body` when provided.
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
 * .from(direct('ingest', {
 *   title: 'Ingest API',
 *   description: 'Accept ingest payloads',
 *   input: { body: mySchema },
 * }))
 *
 * // Destination (client)
 * .to(direct('ingest'))
 * .to(direct((ex) => ex.headers['x-endpoint'] as string))
 * ```
 */
export function direct<B extends StandardSchemaV1 | undefined = undefined>(
  endpoint: RegisteredDirectEndpoint,
  options: Omit<Partial<DirectServerOptions>, "input"> & {
    input?: { body?: B; headers?: StandardSchemaV1 };
  },
): Source<
  B extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<B> : unknown
>;
export function direct<K extends RegisteredDirectEndpoint>(
  endpoint: K,
): Destination<ResolveBody<DirectEndpointRegistry, K>, unknown>;
export function direct<T = unknown>(
  endpoint: DirectEndpoint<T>,
): Destination<T, T>;
export function direct<
  B extends StandardSchemaV1 | undefined = undefined,
  T = unknown,
>(
  endpoint: DirectEndpoint<T>,
  options?:
    | (Omit<Partial<DirectServerOptions>, "input"> & {
        input?: { body?: B; headers?: StandardSchemaV1 };
      })
    | Partial<DirectClientOptions>,
):
  | Source<
      B extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<B> : unknown
    >
  | Destination<T, T> {
  if (options !== undefined) {
    return new DirectSourceAdapter(
      endpoint as string,
      options as Partial<DirectServerOptions>,
    ) as Source<
      B extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<B> : unknown
    >;
  }
  return new DirectDestinationAdapter<T>(endpoint) as Destination<T, T>;
}

// Re-export types for public API
export type {
  DirectChannel,
  DirectChannelType,
  DirectEndpoint,
  DirectInput,
  DirectOutput,
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
