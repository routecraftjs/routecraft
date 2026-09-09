import {
  logger as frameworkLogger,
  isAuthentic,
  isStandardSchema,
  markAuthentic,
  parseDuration,
  rcError,
  type Principal,
} from "@routecraft/routecraft";
import {
  createDeferSentinel,
  type AgentDeferOptions,
  type AgentDeferSentinel,
} from "../agent/defer.ts";
import type {
  FnHandlerContext,
  FnSessionView,
  FnDeferralView,
} from "./types.ts";
// Registers AI1006, thrown from the default defer refusal below.
import "../errors.ts";

/**
 * What the agent tool bridge wires into a handler context when the
 * dispatch can actually deferral: the dispatching exchange's deferral
 * identity. Absent on every other surface, which is what makes
 * `ctx.defer` a typed refusal there.
 *
 * @internal
 */
export interface FnDeferralWiring {
  /** Id the dispatching exchange would defer as. */
  readonly id: string;
  /**
   * Mint the signed resume token for that id (lazily; may throw RC5052).
   *
   * Bound to THIS tool call. Every handler in a parallel batch reads the
   * same deferral id (they name the deferral, not the call) but gets its own
   * credential, so a recipient sent a link by a handler that then lost the
   * deferral cannot resume the winner's deferral: their token carries the losing
   * call's binding and takes `RC5055`.
   */
  readonly mintToken: () => string;
}

/**
 * Construct the synthetic `FnHandlerContext` handed to a tool's guard
 * and handler. Used by the agent tool bridge for every tool invocation
 * and by the MCP server for proxied-tool guards. Mirrors the shape
 * `testFn` provides: `logger`, `abortSignal`, optional `principal`
 * (carried over from the dispatching exchange or the MCP caller so
 * guards can authorise without re-reading the source request), and
 * optional `correlationId`, the dispatching exchange's, so a route a tool
 * forwards to runs under the same trace as the turn that called it.
 *
 * `deferral` wires the durable-deferral affordances: with it,
 * `ctx.defer()` mints the sentinel the bridge converts into a deferral and
 * `ctx.deferralId` / `ctx.deferral` carry the dispatching exchange's
 * deferral identity. Without it (proxied MCP tool guards, synthetic
 * dispatches), `ctx.defer()` refuses with `AI1006` at the moment it is
 * called, before anything could be written.
 *
 * Intentionally does not expose the framework `CraftContext` to tool
 * handlers; built-in tool builders that need to forward to a route
 * (e.g. `directTool`) capture the context at resolve time and thread
 * it through their own closure.
 *
 * @internal
 */
export function makeFnHandlerContext(
  toolName: string,
  abortSignal: AbortSignal,
  principal: Principal | undefined,
  deferral?: FnDeferralWiring,
  session?: FnSessionView,
  correlationId?: string,
): FnHandlerContext {
  return {
    logger: frameworkLogger.child({ tool: toolName }),
    abortSignal,
    ...(correlationId !== undefined ? { correlationId } : {}),
    ...(principal ? { principal: freezePrincipal(principal) } : {}),
    ...(session ? { session: Object.freeze({ ...session }) } : {}),
    ...(deferral
      ? {
          deferralId: deferral.id,
          deferral: makeDeferralView(deferral),
          defer: makeDefer(toolName),
        }
      : { defer: makeDeferRefusal(toolName, session !== undefined) }),
  };
}

/** @internal */
function makeDeferralView(wiring: FnDeferralWiring): FnDeferralView {
  return {
    id: wiring.id,
    // A getter, like `ex.deferral.token`: minting reads the context's
    // signer, and a handler that never builds a resume link should not pay
    // for (or fail on) it.
    get token(): string {
      return wiring.mintToken();
    },
  };
}

/** @internal */
function makeDefer(
  toolName: string,
): (options?: AgentDeferOptions) => AgentDeferSentinel {
  return (options) => {
    if (options?.schema !== undefined) {
      if (!isStandardSchema(options.schema)) {
        throw rcError("RC5003", undefined, {
          message: `ctx.defer in tool "${toolName}": "schema" must be a Standard Schema when given. It renders what a valid resume payload looks like on the Deferred acknowledgment. Omit it entirely to declare no contract.`,
        });
      }
    }
    // Validated here, not only at signal conversion, so a malformed
    // duration throws from the handler's own call frame instead of after
    // the handler has already unwound.
    if (options?.ttl !== undefined) {
      parseDuration(options.ttl, `ctx.defer({ ttl }) in tool "${toolName}"`);
    }
    return createDeferSentinel(options ?? {});
  };
}

/** @internal */
function makeDeferRefusal(
  toolName: string,
  inSession: boolean,
): (options?: AgentDeferOptions) => AgentDeferSentinel {
  return () => {
    // A session turn is revived from the session record, never from a
    // deferred exchange, so the wiring is withheld and the refusal names the
    // combination rather than the unbound dispatch it is not.
    if (inSession) {
      throw rcError("AI1011", undefined, {
        message: `ctx.defer in tool "${toolName}": a turn of an agent dispatched with "session" cannot defer. The session's continuation is revived from its own record, and an approval has no deferred exchange to resume into here. Deferral from a sessionless agent, or move the approval into a route the agent calls as a tool.`,
      });
    }
    throw rcError("AI1006", undefined, {
      message: `ctx.defer in tool "${toolName}": durable deferral is only available inside an agent dispatch on a route-bound exchange. This dispatch has no exchange to defer (a proxied MCP tool guard, a synthetic test dispatch), so nothing was written.`,
    });
  };
}

/**
 * Build a deep-frozen snapshot of the dispatching exchange's
 * principal so a tool handler that bypasses the `ReadonlyPrincipal`
 * type cannot mutate it at runtime.
 *
 * Clones first because `exchange.principal` is mutable by design
 * (the routecraft pipeline lets a `.process()` step attach a custom
 * principal), so freezing the live object in place would break
 * downstream steps.
 *
 * `claims` is deep-cloned via `structuredClone` so that nested
 * claim objects (e.g. `claims.perms.write`) are not shared with the
 * original principal: shallow-cloning the top-level keys would let
 * a tool handler mutate a nested value and have it leak back into
 * the dispatching exchange's principal. After cloning, the entire
 * snapshot is recursively frozen so any runtime mutation attempt
 * (top-level field, array entry, nested claim object) throws.
 *
 * Runs once per resolved tool at `buildVercelTools` time (each tool's
 * handler context holds its own frozen snapshot, reused across that
 * tool's invocations in the dispatch) and once per guarded proxied MCP
 * tool call. Do not rely on reference equality of `ctx.principal` across
 * different tools of one dispatch.
 *
 * @internal
 */
export function freezePrincipal(principal: Principal): Principal {
  // Capture the trusted-origin signal before cloning: the spread below
  // produces a fresh object that is not a member of the authenticity
  // WeakSet, so authenticity must be re-derived from the live principal.
  const wasAuthentic = isAuthentic(principal);
  const snapshot: Principal = { ...principal };
  if (snapshot.audience) snapshot.audience = [...snapshot.audience];
  if (snapshot.scopes) snapshot.scopes = [...snapshot.scopes];
  if (snapshot.roles) snapshot.roles = [...snapshot.roles];
  if (snapshot.claims) snapshot.claims = structuredClone(snapshot.claims);
  // Clone userinfoClaims for the same reason as claims: without it, the
  // shallow spread shares the live principal's object and deepFreeze would
  // freeze the caller's (and the userinfo enrichment cache's) copy in place.
  if (snapshot.userinfoClaims) {
    snapshot.userinfoClaims = structuredClone(snapshot.userinfoClaims);
  }
  // Clone the delegation fields for the same reason: `actor` is a nested
  // Principal chain and `mayAct` an array of matcher objects, both shared
  // by the shallow spread. delegate() output arrives already frozen (so
  // freezing in place would be harmless there), but a principal assembled
  // by a .process() step is mutable and must not have its chain frozen as
  // a side effect of a tool dispatch.
  if (snapshot.actor) snapshot.actor = structuredClone(snapshot.actor);
  if (snapshot.mayAct) snapshot.mayAct = structuredClone(snapshot.mayAct);
  deepFreeze(snapshot);
  // Preserve authenticity across the snapshot: a snapshot of an authentic
  // principal is exactly as authentic as its source, and a snapshot of a
  // self-asserted (plain-object) principal must stay non-authentic so a
  // downstream authorize() still rejects it with RC5023. markAuthentic
  // re-clones and freezes the policy-bearing structures (actor chain,
  // mayAct, roles/scopes/audience); claims and userinfoClaims stay the
  // already deep-frozen references from above.
  return wasAuthentic ? markAuthentic(snapshot) : snapshot;
}

/**
 * Recursively `Object.freeze` an object, walking arrays and plain
 * object values. Cycles are guarded via a visited set so a
 * self-referential principal won't blow the stack. Functions and
 * primitive values are left as-is.
 *
 * Skips `ArrayBuffer.isView` values (TypedArray, DataView, Buffer):
 * `Object.freeze` on a typed array with elements throws because the
 * indexed properties on the backing buffer cannot be made
 * non-configurable. A JWT claim that smuggles binary data (CBOR, an
 * encrypted key, raw bytes) would otherwise crash the dispatch.
 * `structuredClone` (used in `freezePrincipal` for `claims`) already
 * gives us an independent copy of any TypedArray, so the caller's
 * bytes are not shared with the snapshot; tool code that wants
 * write-protection on a binary claim should treat its read as opaque.
 *
 * @internal
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  if (ArrayBuffer.isView(value)) return value;
  seen.add(value as object);
  for (const key of Object.keys(value as object)) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== null && typeof v === "object") deepFreeze(v, seen);
  }
  return Object.freeze(value);
}
