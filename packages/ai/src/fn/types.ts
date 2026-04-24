import type { CraftContext, ResolveKey } from "@routecraft/routecraft";
import { logger as frameworkLogger } from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Minimal context handed to a fn handler. Additional fields may land in
 * follow-up stories without breaking this signature.
 *
 * @experimental
 */
export interface FnHandlerContext {
  /** Pino child logger bound to the fn id. */
  readonly logger: ReturnType<typeof frameworkLogger.child>;
  /** Context-level abort signal. Honour in long-running work. */
  readonly abortSignal: AbortSignal;
  /** CraftContext reference for nested work (direct route calls, events, etc.). */
  readonly context: CraftContext;
}

/**
 * Shape of a fn registered via `agentPlugin({ functions: { id: {...} } })`.
 *
 * The fn id is the record key in the plugin config; this shape only
 * carries the per-fn configuration: description, input schema, and
 * handler.
 *
 * @experimental
 * @template TIn - Input type, typically inferred from the Standard Schema
 * @template TOut - Output type returned by the handler
 */
export interface FnOptions<TIn = unknown, TOut = unknown> {
  /**
   * Human-readable description. Surfaces in observability and is used as
   * the tool description when the fn is exposed to agents.
   */
  description: string;

  /**
   * Standard Schema for the fn's input. Input is validated at invocation
   * time; validation failures throw RC5002.
   */
  schema: StandardSchemaV1<TIn>;

  /**
   * Handler called after schema validation with the (possibly coerced)
   * input and a minimal handler context.
   */
  handler: (input: TIn, ctx: FnHandlerContext) => Promise<TOut> | TOut;
}

/**
 * Registry for configured fns.
 *
 * Keys are fn ids (matching the record keys in `agentPlugin({ functions })`).
 * Populate via declaration merging to narrow `agent({ tools: [...] })`
 * entries to the set of registered fn ids in follow-up stories.
 *
 * @experimental
 *
 * @example
 * ```typescript
 * declare module "@routecraft/ai" {
 *   interface FnRegistry {
 *     currentTime: true;
 *     sendSlackMessage: true;
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: marker interface populated via declaration merging
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Marker interface, populated via declaration merging
export interface FnRegistry {}

/**
 * Resolved fn id type. When `FnRegistry` is populated, constrains to the
 * union of declared ids. Falls back to `string` when the registry is empty.
 *
 * @experimental
 */
export type RegisteredFnId = ResolveKey<FnRegistry>;
