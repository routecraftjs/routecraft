import type {
  Principal,
  ResolveKey,
  Tag,
  logger as frameworkLogger,
} from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Deep-readonly view of a `Principal`. Prevents tool code from
 * mutating the caller's identity at compile time: top-level fields
 * are `readonly` and the array members (`audience`, `scopes`,
 * `roles`) are `readonly string[]` so `.push` / index-assignment
 * fail to typecheck. The `claims` map is wrapped in `Readonly<...>`
 * so its keys cannot be replaced.
 *
 * Runtime protection lives alongside this in tool-bridge, where the
 * principal is `Object.freeze`'d (recursively across the arrays and
 * the claims map) before being stored on the handler context.
 *
 * @experimental
 */
export type ReadonlyPrincipal = Readonly<
  Omit<Principal, "audience" | "scopes" | "roles" | "claims">
> & {
  readonly audience?: readonly string[];
  readonly scopes?: readonly string[];
  readonly roles?: readonly string[];
  readonly claims?: Readonly<Record<string, unknown>>;
};

/**
 * Minimal context handed to a fn handler. Additional fields may land in
 * follow-up stories without breaking this signature.
 *
 * Intentionally does not expose the framework `CraftContext`. Tool
 * handlers must not be able to read context stores (they can hold
 * provider credentials such as LLM API keys), nor reach the dispatch
 * channel directly. Built-in tool builders that need to forward to a
 * route (e.g. `directTool`) capture the context at resolve time and
 * thread it through their own closure rather than via this interface.
 *
 * @experimental
 */
export interface FnHandlerContext {
  /** Pino child logger bound to the fn id. */
  readonly logger: ReturnType<typeof frameworkLogger.child>;
  /** Context-level abort signal. Honour in long-running work. */
  readonly abortSignal: AbortSignal;
  /**
   * Authenticated principal carried over from the exchange that
   * triggered the agent dispatch. Read-only snapshot: tool handlers
   * cannot escalate or impersonate, but can authorise their own work
   * against the caller's identity (e.g.
   * `if (!ctx.principal?.scopes?.includes("write")) throw ...`).
   *
   * Typed as {@link ReadonlyPrincipal} so the field, its arrays
   * (`scopes`, `roles`, `audience`), and the `claims` map are all
   * read-only at compile time. The runtime backs this with a
   * recursive `Object.freeze` so a tool that bypasses the type
   * system still cannot tamper.
   *
   * Undefined when the originating exchange had no principal (e.g.
   * an unauthenticated source, or `testFn` outside a context).
   */
  readonly principal?: ReadonlyPrincipal;
  /**
   * Correlation id of the calling exchange, when the fn was invoked
   * from inside a running route or agent dispatch. Propagated to any
   * child exchanges (e.g. direct route calls) so traces stay linked.
   */
  readonly correlationId?: string;

  /**
   * Identifier for the durable-agents checkpoint when the fn is
   * running inside a checkpointed agent session. Undefined today (no
   * runtime populates it); the durable-agents epic supplies a real
   * value so a tool handler that suspends can hand it to the
   * resumption channel (e.g. embed it in a callback URL).
   *
   * Exposed now so handlers written today can be forward-compat with
   * the durable epic without changing signature.
   *
   * @experimental
   */
  readonly checkpointId?: string;
}

/**
 * Shape of a fn registered via `agentPlugin({ functions: { id: {...} } })`.
 *
 * The fn id is the record key in the plugin config; this shape only
 * carries the per-fn configuration: description, input schema, and
 * handler.
 *
 * `TIn` is the schema's validated/coerced output type, which is what
 * the handler receives. For schemas with `.transform()`, this differs
 * from the raw input type the schema accepts.
 *
 * @experimental
 * @template TIn - Schema's validated output type (handler input type)
 * @template TOut - Handler return type
 */
export interface FnOptions<TIn = unknown, TOut = unknown> {
  /**
   * Human-readable description. Surfaces in observability and is used as
   * the tool description when the fn is exposed to agents.
   */
  description: string;

  /**
   * Standard Schema for the fn's input. Input is validated at invocation
   * time; validation failures throw RC5002. The schema's output type
   * (after any `.transform()`) is what the handler sees.
   */
  input: StandardSchemaV1<unknown, TIn>;

  /**
   * Handler called after schema validation with the (possibly coerced)
   * input and a minimal handler context.
   */
  handler: (input: TIn, ctx: FnHandlerContext) => Promise<TOut> | TOut;

  /**
   * Tags used by selectors (e.g. agents whitelisting
   * `{ tagged: "read-only" }`). Use the `KnownTag` literals where they
   * fit ("read-only", "destructive", "idempotent") and any string
   * otherwise.
   *
   * Must be an array (or omitted). Non-array values, non-string
   * entries, and empty-string entries all throw RC5003 at context
   * init. Surrounding whitespace is trimmed at storage so selectors
   * match by exact value.
   */
  tags?: Tag[];
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
 *     CurrentTime: true;
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
