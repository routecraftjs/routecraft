import type {
  Principal,
  ResolveKey,
  Tag,
  logger as frameworkLogger,
} from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AgentSuspendOptions,
  AgentSuspendSentinel,
} from "../agent/suspend.ts";

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
   * Id of the suspension this dispatch's exchange would park as (or parked
   * as), populated BEFORE the handler runs so a callback URL can be built
   * ahead of the actual park. Present only inside an agent dispatch on a
   * route-bound exchange; undefined on other surfaces (proxied MCP tool
   * guards, `testFn`). Renamed from the `checkpointId` stub per the naming
   * decision on #417.
   *
   * Deliberately an alias of {@link FnSuspensionView.id} on
   * {@link FnHandlerContext.suspension}, kept as the flat ergonomic form
   * the #417 rename recorded; `ctx.suspension` is the authoritative view
   * and the two always agree.
   */
  readonly suspensionId?: string;

  /**
   * Suspension view of the dispatching exchange, mirroring
   * `ex.suspension`: the id above plus the signed resume token, both
   * mintable before the handler suspends so an approval request can carry
   * a working resume link. Reading `token` throws `RC5052` when the
   * context has no suspension runtime configured. Present only inside an
   * agent dispatch on a route-bound exchange.
   */
  readonly suspension?: FnSuspensionView;

  /**
   * The named session the calling turn belongs to, when the agent was
   * dispatched with `agent(name, { session })`. Read-only identity: a tool
   * that needs the conversation's own key (a per-session workspace, a
   * background result that must land in this conversation) reads it here
   * rather than trusting the model to pass it as input. Undefined for a
   * sessionless dispatch and on every other surface.
   */
  readonly session?: FnSessionView;

  /**
   * Park the run: the handler cannot answer now, so the agent's tool loop
   * stops, the exchange is durably suspended through the core store, and
   * the caller receives the framework's `Suspended` acknowledgment.
   * `return ctx.suspend({ schema, ttl })` is the whole protocol; the
   * returned sentinel must be returned as-is, immediately.
   *
   * In-flight sibling tool calls of the same batch are awaited and their
   * results persisted before the park; a second suspend signal in one
   * batch is recorded as a tool error the resumed model can retry.
   *
   * Only available inside an agent dispatch on a route-bound exchange:
   * anywhere else (a proxied MCP tool guard, `testFn` without its own
   * stub, an agent dispatched over a synthetic exchange) the call throws
   * `AI1006` at the moment it is made and nothing is written.
   */
  readonly suspend: (options?: AgentSuspendOptions) => AgentSuspendSentinel;
}

/**
 * The suspension affordance handed to fn handlers, a snapshot of the
 * dispatching exchange's `ex.suspension` narrowed to what a handler needs
 * to build its resumption channel.
 */
export interface FnSuspensionView {
  /** Id the exchange would park as (or parked as). */
  readonly id: string;
  /**
   * Signed, single-use resume token for {@link FnSuspensionView.id}.
   * Minted lazily on read; throws `RC5052` when the context has no
   * suspension runtime configured.
   */
  readonly token: string;
}

/**
 * The session identity handed to fn handlers. See
 * {@link FnHandlerContext.session}.
 */
export interface FnSessionView {
  /** The registered agent the session belongs to. */
  readonly agent: string;
  /** The caller-chosen session id. */
  readonly id: string;
}

/**
 * Synchronous or async guard run before the underlying handler. Throwing
 * rejects the call: for agent tools the error surfaces back to the LLM as
 * a tool error so the model can self-correct; for proxied MCP tools
 * (`mcpPlugin({ proxy })`) it becomes an `isError` result for the calling
 * client. The context carries the caller's read-only `principal` (when
 * authenticated) so guards can authorise by identity, role, or scope.
 *
 * Input validation differs per surface, so treat `input` as untrusted:
 * agent tools validate the input against the tool's schema BEFORE the
 * guard runs, but MCP proxy guards receive the caller's raw arguments
 * verbatim (the remote server is the validator and runs AFTER the guard).
 * A guard shared across both surfaces must not assume a validated shape;
 * check structure before dereferencing.
 */
export type ToolGuard = (
  input: unknown,
  ctx: FnHandlerContext,
) => void | Promise<void>;

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
   * Tags surfaced on `ToolsCatalog.fns[].tags` for the builder form
   * of `tools((catalog) => catalog.fns.filter(f => f.tags?.includes("read-only")).map(f => f.name))`.
   * Use the `KnownTag` literals where they fit ("read-only",
   * "destructive", "idempotent") and any string otherwise.
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
 */
export type RegisteredFnId = ResolveKey<FnRegistry>;
