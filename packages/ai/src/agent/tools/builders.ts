import { randomUUID } from "node:crypto";
import {
  HeadersKeys,
  type Authority,
  rcError,
  type Capability,
  type ExchangeHeaders,
  type Principal,
} from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FnHandlerContext, ReadonlyPrincipal } from "../../fn/types.ts";
import { authorityOfHandler } from "../../fn/handler-context.ts";
import { errorOf, outcomeOfResult } from "../session/runtime.ts";
import { isDownstreamDeferred } from "../downstream-deferred.ts";
import { AgentHeadersKeys } from "./headers.ts";
import {
  LAZY_FN_BRAND,
  FN_BACKGROUND,
  type LazyFn,
  type RegisteredFn,
  type ToolHost,
} from "./types.ts";

/**
 * Re-hydrate a frozen `ReadonlyPrincipal` (as exposed on
 * `FnHandlerContext`) into a fresh mutable `Principal` so it can be
 * attached to a downstream `DefaultExchange`.
 *
 * Arrays are spread-cloned and `claims` is deep-cloned via
 * `structuredClone` so the downstream principal shares no references
 * with the agent's frozen snapshot.
 *
 * Authenticity is forwarded only when the principal that triggered the
 * agent was itself authentic: `isAuthentic(rp)` is true for a JWT /
 * `authenticate()` identity (the tool-bridge preserves the trusted-origin
 * signal on the frozen snapshot) and false for a self-asserted plain-object
 * principal. Re-branding restores the brand the spread strips for the
 * legitimate case; leaving it unbranded for the self-asserted case lets the
 * downstream route's `authorize()` correctly reject it with RC5023, instead
 * of laundering an unverified caller into a trusted one across the
 * agent -> tool boundary. The agent layer never mints or escalates: it only
 * forwards the identity it was handed.
 */
function cloneFrozenPrincipal(
  rp: ReadonlyPrincipal,
  authority: Authority,
): Principal {
  const out: Principal = { ...rp } as Principal;
  if (rp.audience) out.audience = [...rp.audience];
  if (rp.scopes) out.scopes = [...rp.scopes];
  if (rp.roles) out.roles = [...rp.roles];
  if (rp.claims)
    out.claims = structuredClone(rp.claims) as Record<string, unknown>;
  return authority.isAuthentic(rp) ? authority.brand(out) : out;
}

/**
 * Per-call overrides accepted by the builder helpers. Lets the caller
 * narrow the underlying tool's surface to a specific agent without
 * touching the underlying registration.
 *
 * `description` and `input` narrow what the model sees; `background`
 * changes how the agent awaits the route. Guards are policy and live at
 * the consumer (attach them in `tools([{ name, guard }])` at the agent's
 * call site). Tags were previously overridable to influence the removed
 * tag-based selector; without that selector the override has no effect
 * at runtime, so the field is gone.
 */
export interface ToolBuilderOverrides<TIn = unknown> {
  /** Replace the underlying description shown to the LLM. */
  description?: string;
  /**
   * Replace the underlying input schema. Replaces, does not merge with,
   * the underlying schema.
   */
  input?: StandardSchemaV1<unknown, TIn>;
  /**
   * Return a handle now and deliver the result later.
   *
   * The call dispatches the route as usual and returns
   * `{ handle, status: "running" }` immediately, so a build or a test run
   * that takes minutes does not hold the agent's turn. When the route
   * finishes, its result (or its failure, as a typed message) is posted to
   * the calling session's inbox attributed to the handle, and the model
   * reads it at the start of its next turn. The handle is the route id
   * plus a dispatch id, stable across restarts and written on the
   * dispatched exchange's headers so the run can be found.
   *
   * A property of how this agent awaits this route, not of the route: the
   * route stays an ordinary `direct()` route callable synchronously by
   * anything else. Needs a session to deliver into, so an agent dispatched
   * without `session` refuses the tool when its tool list is resolved
   * (`RC5003`). The description the model sees says the tool is
   * asynchronous, so it does not wait on the return value.
   *
   * The tool's shape follows the route's shape. A route that can park (a
   * `.defer()`, a defer-capable step, or an error-slot hook that may park
   * it) is background without being declared so, because its dispatch
   * answers with a `Deferred` acknowledgment rather than a result: the
   * handle stays open through the park and settles with execution two's
   * outcome, so a decline reaches the model as an ordinary background
   * message it can revise and ask again from. `false` on such a route is
   * refused when the tool resolves (`RC5003` naming the route), because
   * the alternative is telling the model a call completed and handing it
   * a receipt it cannot use. `true` is still what an author writes for a
   * route that does not park but is slow.
   */
  background?: boolean;
}

/** What a background call returns to the model in place of the route's result. */
export interface BackgroundToolHandle {
  /**
   * `<routeId>:<dispatchId>`, the key the later inbox message names. The
   * dispatch id rides on the dispatched exchange as
   * `routecraft.agent.background.handle`.
   */
  readonly handle: string;
  readonly status: "running";
}

/**
 * Appended to a background tool's description so the model knows the
 * return value is a receipt, not the answer.
 *
 * @internal
 */
export const BACKGROUND_DESCRIPTION_SUFFIX =
  ' This tool runs in the background: it returns { handle, status: "running" } immediately, and its result arrives later as a message naming that handle. Do not wait for the result in this turn.';

/**
 * Wrap a registered direct route as a fn-shaped tool. The route's
 * `.description()`, `.input()` schema, and tags become the fn's
 * description, input, and tags by default; pass `overrides` to narrow
 * `description` or `input` for the calling agent.
 *
 * Resolution is deferred to agent dispatch time, when the direct
 * registry is populated. Errors at resolution (unknown route id,
 * missing description, missing input schema) throw `RC5003`.
 *
 * @example
 * ```ts
 * agentPlugin({
 *   functions: {
 *     fetchOrder: directTool("fetch-order"),
 *     safeFetchOrder: directTool("fetch-order", {
 *       description: "Read-only order fetch.",
 *     }),
 *   },
 * });
 * ```
 */
export function directTool<TIn = unknown>(
  routeId: string,
  overrides?: ToolBuilderOverrides<TIn>,
): LazyFn {
  if (typeof routeId !== "string" || routeId.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `directTool: routeId must be a non-empty string.`,
    });
  }
  return {
    [LAZY_FN_BRAND]: true,
    kind: "direct",
    targetId: routeId,
    resolve(host, fnId): RegisteredFn {
      const route = readDirectRoute(host, routeId, fnId);
      const description = overrides?.description ?? route.description;
      if (typeof description !== "string" || description.trim() === "") {
        throw rcError("RC5003", undefined, {
          message: `directTool: route "${routeId}" has no .description() and no override was provided (referenced as fn "${fnId}").`,
        });
      }
      const input =
        overrides?.input ??
        (route.input?.body as StandardSchemaV1<unknown, TIn> | undefined);
      if (!input) {
        throw rcError("RC5003", undefined, {
          message: `directTool: route "${routeId}" has no .input(...) schema and no override was provided (referenced as fn "${fnId}").`,
        });
      }
      const tags = route.tags;
      const parks = host.canDefer(routeId);
      if (overrides?.background === false && parks) {
        throw rcError("RC5003", undefined, {
          message: `directTool: route "${routeId}" can park (a .defer(), a defer-capable step, or an error-slot hook that may park it), so its dispatch may answer with a Deferred acknowledgment in place of a result; a synchronous tool over it would tell the model the call completed. Drop background: false on it (referenced as fn "${fnId}").`,
        });
      }
      const fields = {
        input,
        ...(tags && tags.length > 0 ? { tags: [...tags] } : {}),
      };
      if (overrides?.background ?? parks) {
        const background: RegisteredFn = {
          ...fields,
          description: `${description}${BACKGROUND_DESCRIPTION_SUFFIX}`,
          handler: (body: TIn, hctx: FnHandlerContext) =>
            dispatchBackground(host, hctx, routeId, fnId, body),
        };
        return Object.assign(background, {
          [FN_BACKGROUND]: parks ? "parks" : "declared",
        });
      }
      return {
        ...fields,
        description,
        handler: (body: TIn, hctx: FnHandlerContext) =>
          dispatchDirect(host, hctx, routeId, body),
      };
    },
  };
}

/**
 * Headers a direct dispatch from a tool carries: the caller's correlation
 * id so traces stay linked, and the calling principal, forwarded as a
 * fresh mutable copy (see {@link cloneFrozenPrincipal}).
 */
function dispatchHeaders(hctx: FnHandlerContext): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  if (hctx.correlationId) {
    headers[HeadersKeys.CORRELATION_ID] = hctx.correlationId;
  }
  if (hctx.principal) {
    headers[HeadersKeys.AUTH_PRINCIPAL] = cloneFrozenPrincipal(
      hctx.principal,
      authorityOfHandler(hctx),
    );
  }
  return headers;
}

/**
 * Dispatch the route and return a handle at once. The result or the
 * failure is delivered to the calling session's inbox by the session
 * runtime when the run that carries it ends, attributed to the handle.
 *
 * The dispatch id is minted here and carried on the dispatched exchange's
 * headers with the session: a route mints its own exchange id, so the
 * header is what lets an operator join the handle to the run, and both
 * survive a park with the exchange, which is how execution two settles
 * the handle it was dispatched under. A dispatch that resolves with the
 * route's result settles the handle here; one that resolves with a
 * `Deferred` acknowledgment records the park beside the handle instead,
 * so the model keeps holding a `running` handle, which is true, and the
 * session runtime settles it from execution two's terminal event.
 *
 * @internal
 */
async function dispatchBackground<TIn>(
  host: ToolHost,
  hctx: FnHandlerContext,
  routeId: string,
  toolName: string,
  input: TIn,
): Promise<BackgroundToolHandle> {
  // Wiring defence: the enricher refuses a background tool on a sessionless
  // dispatch before the model can call it, so reaching here without a
  // session means the tool was invoked outside an agent turn.
  const session = hctx.session;
  if (!session) {
    throw rcError("RC5003", undefined, {
      message: `directTool "${routeId}" runs in the background, which delivers its result to the calling agent's session inbox, and this call has no session. Dispatch the agent with agent(name, { session }).`,
    });
  }
  if (hctx.abortSignal.aborted) {
    throw abortError(routeId, hctx.abortSignal.reason);
  }
  const runtime = host.sessions();
  const key = session.id;
  const dispatchId = randomUUID();
  const handle = `${routeId}:${dispatchId}`;
  const startedAt = new Date();
  const by = hctx.principal?.subject ?? null;
  await runtime.startBackground(key, session.agent, {
    handle,
    tool: toolName,
    startedAt: startedAt.toISOString(),
    by,
  });
  const headers: ExchangeHeaders = {
    ...dispatchHeaders(hctx),
    [AgentHeadersKeys.BACKGROUND_HANDLE]: handle,
    [AgentHeadersKeys.BACKGROUND_SESSION]: key,
  } as ExchangeHeaders;
  const about = { agent: session.agent, session: key, handle, tool: toolName };
  const report = (work: Promise<unknown>): void => runtime.track(work, about);
  // Deliberately not awaited: the turn continues, and the settlement is
  // the runtime's business.
  void host.deliver(routeId, input, headers).then(
    (result) => {
      // Only the id is read: the acknowledgment carries a live resume
      // token, and the model must never hold its own park's token.
      const deferralId = parkedOn(result);
      if (deferralId !== undefined) {
        report(runtime.parkBackground(key, handle, deferralId));
        return;
      }
      report(
        runtime.settleBackground(key, { handle, ...outcomeOfResult(result) }),
      );
    },
    (err: unknown) =>
      report(
        runtime.settleBackground(key, {
          handle,
          status: "failed",
          error: errorOf(err),
        }),
      ),
  );
  return { handle, status: "running" };
}

/**
 * The deferral a dispatch's result says the route parked on, or
 * `undefined` for a result that is not a `Deferred` acknowledgment. A
 * result that throws while inspected is not one; {@link outcomeOfResult}
 * retires it without reading it.
 *
 * @internal
 */
function parkedOn(result: unknown): string | undefined {
  try {
    return isDownstreamDeferred(result)
      ? (result as { deferralId: string }).deferralId
      : undefined;
  } catch {
    return undefined;
  }
}

function readDirectRoute(
  host: ToolHost,
  routeId: string,
  fnId: string,
): Capability {
  const capabilities = host.capabilities();
  const route = capabilities.find((c) => c.endpoint === routeId);
  if (!route) {
    // A route that exists without a capability is not a typo, so "unknown
    // route id" would be a lie and "register it" wrong advice.
    if (host.hasRoute(routeId)) {
      throw rcError("RC5003", undefined, {
        message: `directTool: route "${routeId}" exists but is not a discoverable direct() capability: it is declared internal (direct({ internal: true })), is disabled, or has no direct() source, so it cannot be exposed as a tool (referenced as fn "${fnId}"). Expose a boundary route carrying .input(), .description() and .authorize() instead, and point the tool at that.`,
      });
    }
    const known = capabilities.map((c) => c.endpoint).sort();
    throw rcError("RC5003", undefined, {
      message:
        `directTool: unknown direct route id "${routeId}" (referenced as fn "${fnId}"). ` +
        (known.length > 0
          ? `Known route ids: ${known.join(", ")}.`
          : `No direct routes are registered in this context.`),
    });
  }
  return route;
}

async function dispatchDirect<TIn>(
  host: ToolHost,
  hctx: FnHandlerContext,
  routeId: string,
  input: TIn,
): Promise<unknown> {
  // A cancelled run must not START new downstream work; a dispatch already
  // in flight when the abort fires unwinds the agent promptly below while
  // the downstream route finishes under its own lifecycle (its cancellation
  // story is the route's, not this tool's).
  if (hctx.abortSignal.aborted) {
    throw abortError(routeId, hctx.abortSignal.reason);
  }
  // Forward the calling principal so the downstream direct route sees
  // the same authenticated identity as the agent that invoked the
  // tool. The agent layer never lets a tool override or escalate this:
  // `principal` is deeply-readonly on FnHandlerContext (frozen at the
  // tool-bridge boundary). Hand the downstream exchange a fresh
  // mutable copy so a `.process()` step downstream may legitimately
  // attach a different principal; the tool handler's own snapshot
  // stays frozen and unaffected.
  const headers = dispatchHeaders(hctx);
  const dispatch = host.deliver(
    routeId,
    input,
    Object.keys(headers).length > 0 ? headers : undefined,
  );
  return raceAbort(dispatch, hctx.abortSignal, routeId);
}

/**
 * Resolve with the dispatch, or reject as soon as the run's abort signal
 * fires: the agent must unwind promptly on cancellation instead of waiting
 * out a downstream route it no longer wants the answer from. The dispatch
 * promise is left to settle on its own (and observed, so an eventual
 * rejection is not an unhandled one).
 *
 * @internal
 */
function raceAbort(
  dispatch: Promise<unknown>,
  signal: AbortSignal,
  routeId: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError(routeId, signal.reason));
    // An already-aborted signal never fires "abort" again, so a listener
    // installed now would wait out the downstream instead of unwinding.
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    dispatch.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** @internal */
function abortError(routeId: string, reason: unknown): Error {
  const err = new Error(
    `directTool "${routeId}": the agent run was cancelled${
      reason ? ` (${String(reason)})` : ""
    }.`,
  );
  err.name = "AbortError";
  return err;
}
