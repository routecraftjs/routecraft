import type { Duration } from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Cross-instance brand for {@link AgentDeferSentinel}, `Symbol.for`-keyed
 * so duplicate copies of this package in one process agree on it.
 *
 * @internal
 */
const DEFER_SENTINEL_BRAND = Symbol.for("routecraft.ai.agentDeferSentinel");

/**
 * What a fn handler passes to `ctx.defer()`: the same pieces the core
 * `.defer({ schema, ttl, meta })` operation declares, so an agent-raised
 * deferral and a route-raised one are the same record with the same
 * options.
 */
export interface AgentDeferOptions {
  /**
   * What a valid resume payload looks like. Rendered onto the `Deferred`
   * acknowledgment (so the caller can see the shape) and folded into the
   * deferral's compatibility hash.
   *
   * Descriptive at resume time, unlike the core operation's `schema`: the
   * live schema exists only in this handler's code, so after a restart the
   * framework cannot re-validate against it and the payload reaches the
   * model as an ordinary, untrusted tool result. Treat it accordingly.
   */
  schema?: StandardSchemaV1;
  /**
   * How long the deferral stays resumable (e.g. `"72h"`). Omitted means
   * the context's `defaultTtl`. Expiry re-enters the route's error channel
   * with `RC5047`, exactly as with the core operation.
   */
  ttl?: Duration;
  /**
   * Anything the resuming route needs to decide who may resume, or that an
   * operator needs to read off the record.
   *
   * Identical to the core `.defer({ meta })` option, deliberately: an
   * agent-raised deferral and a route-raised one are the same record with
   * the same policy point, so there is no agent-shaped variant to learn.
   * Plain JSON, persisted verbatim, never interpreted by the framework, and
   * handed to `.resume({ authorize })` at revive.
   *
   * A tool handler supplies it, which means the MODEL influenced it. Design
   * the resuming route's hook so it does not trust this text on its own.
   */
  meta?: unknown;
}

/**
 * The value `ctx.defer()` returns and a deferring handler returns to the
 * runtime. Opaque by convention: return it as-is, immediately. The type is
 * structural (so test harnesses can produce a compatible shape without
 * depending on this package), and the runtime check is the brand the
 * factory applies.
 */
export interface AgentDeferSentinel {
  readonly status: "defer-requested";
  /** What the handler asked for. Read by the agent runtime at the deferral. */
  readonly request: AgentDeferOptions;
}

/**
 * Mint the sentinel `ctx.defer()` hands back. Branded so the tool bridge
 * recognises it without shape-sniffing a result a tool could also produce.
 *
 * @internal
 */
export function createDeferSentinel(
  request: AgentDeferOptions,
): AgentDeferSentinel {
  const sentinel: AgentDeferSentinel = {
    status: "defer-requested",
    request,
  };
  (sentinel as unknown as Record<symbol, boolean>)[DEFER_SENTINEL_BRAND] = true;
  return sentinel;
}

/**
 * Whether a tool handler's return value is the `ctx.defer()` sentinel.
 *
 * @internal
 */
export function isDeferSentinel(value: unknown): value is AgentDeferSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[DEFER_SENTINEL_BRAND] === true
  );
}

/**
 * Escape-hatch signal: throw from a fn handler to defer the agent's tool
 * loop when returning is impossible (the deferral decision is made deep
 * inside a call stack that cannot thread a return value out).
 *
 * **Prefer `ctx.defer()`**, which is the documented path. Control flow
 * through exceptions has a footgun this class cannot remove: a handler that
 * wraps its work in `try/catch` will silently swallow a thrown deferral
 * and carry on, handing the model a garbage tool result instead of deferring
 * the run. The sentinel return cannot be swallowed that way.
 *
 * Outside an agent dispatch (a proxied MCP tool guard, `testFn`), throwing
 * this behaves like any other error.
 *
 * @example
 * ```ts
 * import { DeferError } from "@routecraft/ai"
 *
 * const askApproval: FnOptions = {
 *   description: "Ask a human for approval via email",
 *   input: z.object({ request: z.string() }),
 *   handler: async (input, ctx) => {
 *     await sendApprovalRequest({ request: input.request, ctx })
 *     throw new DeferError({ schema: Approval, ttl: "72h" })
 *   },
 * }
 * ```
 */
export class DeferError extends Error {
  /** Discriminator for runtime detection. */
  override readonly name = "DeferError";
  /**
   * What a valid resume payload looks like. Absent, the deferral declares
   * no contract at all and the payload reaches the model unvalidated, which
   * is the trust level every tool result already has.
   */
  readonly schema?: StandardSchemaV1;
  /** How long the deferral stays resumable. Omitted means the context default. */
  readonly ttl?: Duration;
  /** Policy inputs the defer site attached. See {@link AgentDeferOptions.meta}. */
  readonly meta?: unknown;

  constructor(opts?: AgentDeferOptions) {
    super("Agent deferred pending external resumption.");
    if (opts?.schema !== undefined) this.schema = opts.schema;
    if (opts?.ttl !== undefined) this.ttl = opts.ttl;
    if (opts?.meta !== undefined) this.meta = opts.meta;
  }
}

/**
 * Type guard for `DeferError`. Used by the runtime to detect
 * deferral signals without importing the concrete class everywhere.
 *
 * @internal
 */
export function isDeferError(value: unknown): value is DeferError {
  return value instanceof DeferError;
}
