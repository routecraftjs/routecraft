import {
  logger as frameworkLogger,
  isAuthentic,
  markAuthentic,
  type Principal,
} from "@routecraft/routecraft";
import type { FnHandlerContext } from "./types.ts";

/**
 * Construct the synthetic `FnHandlerContext` handed to a tool's guard
 * and handler. Used by the agent tool bridge for every tool invocation
 * and by the MCP server for proxied-tool guards. Mirrors the shape
 * `testFn` provides: `logger`, `abortSignal`, optional `principal`
 * (carried over from the dispatching exchange or the MCP caller so
 * guards can authorise without re-reading the source request),
 * optional `correlationId` (not yet populated by the runtime), and
 * optional `checkpointId` (durable-agents epic).
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
): FnHandlerContext {
  return {
    logger: frameworkLogger.child({ tool: toolName }),
    abortSignal,
    ...(principal ? { principal: freezePrincipal(principal) } : {}),
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
