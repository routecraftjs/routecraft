import type { Duration } from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Cross-instance brand for {@link AgentSuspendSentinel}, `Symbol.for`-keyed
 * so duplicate copies of this package in one process agree on it.
 *
 * @internal
 */
const SUSPEND_SENTINEL_BRAND = Symbol.for("routecraft.ai.agentSuspendSentinel");

/**
 * What a fn handler passes to `ctx.suspend()`: the same pieces the core
 * `.suspend({ schema, ttl, meta })` operation declares, so an agent-raised
 * suspension and a route-raised one are the same record with the same
 * options.
 */
export interface AgentSuspendOptions {
  /**
   * What a valid resume payload looks like. Rendered onto the `Suspended`
   * acknowledgment (so the caller can see the shape) and folded into the
   * suspension's compatibility hash.
   *
   * Descriptive at resume time, unlike the core operation's `schema`: the
   * live schema exists only in this handler's code, so after a restart the
   * framework cannot re-validate against it and the payload reaches the
   * model as an ordinary, untrusted tool result. Treat it accordingly.
   */
  schema?: StandardSchemaV1;
  /**
   * How long the suspension stays resumable (e.g. `"72h"`). Omitted means
   * the context's `defaultTtl`. Expiry re-enters the route's error channel
   * with `RC5047`, exactly as with the core operation.
   */
  ttl?: Duration;
  /**
   * Anything the resuming route needs to decide who may resume, or that an
   * operator needs to read off the record.
   *
   * Identical to the core `.suspend({ meta })` option, deliberately: an
   * agent-raised suspension and a route-raised one are the same record with
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
 * The value `ctx.suspend()` returns and a suspending handler returns to the
 * runtime. Opaque by convention: return it as-is, immediately. The type is
 * structural (so test harnesses can produce a compatible shape without
 * depending on this package), and the runtime check is the brand the
 * factory applies.
 */
export interface AgentSuspendSentinel {
  readonly status: "suspend-requested";
  /** What the handler asked for. Read by the agent runtime at the park. */
  readonly request: AgentSuspendOptions;
}

/**
 * Mint the sentinel `ctx.suspend()` hands back. Branded so the tool bridge
 * recognises it without shape-sniffing a result a tool could also produce.
 *
 * @internal
 */
export function createSuspendSentinel(
  request: AgentSuspendOptions,
): AgentSuspendSentinel {
  const sentinel: AgentSuspendSentinel = {
    status: "suspend-requested",
    request,
  };
  (sentinel as unknown as Record<symbol, boolean>)[SUSPEND_SENTINEL_BRAND] =
    true;
  return sentinel;
}

/**
 * Whether a tool handler's return value is the `ctx.suspend()` sentinel.
 *
 * @internal
 */
export function isSuspendSentinel(
  value: unknown,
): value is AgentSuspendSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[SUSPEND_SENTINEL_BRAND] === true
  );
}

/**
 * Escape-hatch signal: throw from a fn handler to suspend the agent's tool
 * loop when returning is impossible (the suspension decision is made deep
 * inside a call stack that cannot thread a return value out).
 *
 * **Prefer `ctx.suspend()`**, which is the documented path. Control flow
 * through exceptions has a footgun this class cannot remove: a handler that
 * wraps its work in `try/catch` will silently swallow a thrown suspension
 * and carry on, handing the model a garbage tool result instead of parking
 * the run. The sentinel return cannot be swallowed that way.
 *
 * Outside an agent dispatch (a proxied MCP tool guard, `testFn`), throwing
 * this behaves like any other error.
 *
 * @example
 * ```ts
 * import { SuspendError } from "@routecraft/ai"
 *
 * const askApproval: FnOptions = {
 *   description: "Ask a human for approval via email",
 *   input: z.object({ request: z.string() }),
 *   handler: async (input, ctx) => {
 *     await sendApprovalRequest({ request: input.request, ctx })
 *     throw new SuspendError({ schema: Approval, ttl: "72h" })
 *   },
 * }
 * ```
 */
export class SuspendError extends Error {
  /** Discriminator for runtime detection. */
  override readonly name = "SuspendError";
  /**
   * What a valid resume payload looks like. Absent, the suspension declares
   * no contract at all and the payload reaches the model unvalidated, which
   * is the trust level every tool result already has.
   */
  readonly schema?: StandardSchemaV1;
  /** How long the suspension stays resumable. Omitted means the context default. */
  readonly ttl?: Duration;
  /**
   * Optional channel hint indicating how the agent will be resumed.
   * Surfaces in telemetry only; the durable record does not carry it.
   */
  readonly resumeChannel?: string;

  /** Policy inputs the parker attached. See {@link AgentSuspendOptions.meta}. */
  readonly meta?: unknown;

  constructor(opts?: {
    schema?: StandardSchemaV1;
    ttl?: Duration;
    resumeChannel?: string;
    meta?: unknown;
  }) {
    super("Agent suspended pending external resumption.");
    if (opts?.schema !== undefined) this.schema = opts.schema;
    if (opts?.ttl !== undefined) this.ttl = opts.ttl;
    if (opts?.resumeChannel !== undefined) {
      this.resumeChannel = opts.resumeChannel;
    }
    if (opts?.meta !== undefined) this.meta = opts.meta;
  }
}

/**
 * Type guard for `SuspendError`. Used by the runtime to detect
 * suspension signals without importing the concrete class everywhere.
 *
 * @internal
 */
export function isSuspendError(value: unknown): value is SuspendError {
  return value instanceof SuspendError;
}
