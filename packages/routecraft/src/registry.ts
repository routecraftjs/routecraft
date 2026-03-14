/**
 * Type registries for compile-time safety via declaration merging.
 *
 * Users populate these empty interfaces in their project to enable
 * strict autocomplete and red-line errors for misconfigured endpoints,
 * providers, and event names. When a registry is empty, the corresponding
 * adapter falls back to accepting any string (no breaking change).
 *
 * @example
 * ```typescript
 * // In your project's types file:
 * declare module '@routecraft/routecraft' {
 *   interface DirectEndpointRegistry {
 *     'payments': PaymentData;
 *     'orders': OrderData;
 *   }
 * }
 *
 * // Now direct('payments', { ... }) autocompletes and
 * // direct('nonexistent', { ... }) shows a red line.
 * ```
 */

/**
 * Registry for direct adapter endpoints.
 *
 * Keys are endpoint strings (e.g. 'payments'), values are the body type
 * for that endpoint. Populate via declaration merging to constrain
 * `direct()`, `ForwardFn`, and related APIs.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Marker interface, populated via declaration merging
export interface DirectEndpointRegistry {}

/**
 * Registry for plugin event names.
 *
 * Keys are event name strings, values are the event payload type.
 * Plugin packages can ship their own `declare module` blocks to
 * augment this registry automatically on import.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Marker interface, populated via declaration merging
export interface PluginEventRegistry {}

/**
 * Resolves a registry to its string keys when populated,
 * or falls back to `string` when the registry is empty.
 *
 * @template Registry - The registry interface to resolve
 */
export type ResolveKey<Registry> = keyof Registry extends never
  ? string
  : Extract<keyof Registry, string>;

/**
 * Resolved direct endpoint type.
 * Constrained to registered endpoints when `DirectEndpointRegistry` is populated,
 * falls back to `string` when empty.
 */
export type RegisteredDirectEndpoint = ResolveKey<DirectEndpointRegistry>;
