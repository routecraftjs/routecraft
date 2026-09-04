import { randomUUID } from "node:crypto";
import {
  CraftClient,
  HeadersKeys,
  isAuthentic,
  isInternalEndpoint,
  markAuthentic,
  rcCodeOf,
  rcError,
  type Capability,
  type CraftContext,
  type ExchangeHeaders,
  type Principal,
} from "@routecraft/routecraft";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  FnHandlerContext,
  FnOptions,
  ReadonlyPrincipal,
} from "../../fn/types.ts";
import {
  AgentSessionRuntime,
  type BackgroundOutcome,
} from "../session/runtime.ts";
import { DEFERRED_FN_BRAND, FN_BACKGROUND, type DeferredFn } from "./types.ts";

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
function cloneFrozenPrincipal(rp: ReadonlyPrincipal): Principal {
  const out: Principal = { ...rp } as Principal;
  if (rp.audience) out.audience = [...rp.audience];
  if (rp.scopes) out.scopes = [...rp.scopes];
  if (rp.roles) out.roles = [...rp.roles];
  if (rp.claims)
    out.claims = structuredClone(rp.claims) as Record<string, unknown>;
  return isAuthentic(rp) ? markAuthentic(out) : out;
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
   */
  background?: boolean;
}

/**
 * Header keys the agent tier writes on exchanges it dispatches.
 */
export const AgentHeadersKeys = {
  /**
   * The background handle a dispatched exchange belongs to, so an operator
   * reading the route's exchanges can find the run a handle names. The
   * route mints its own exchange id, so this is the join key.
   */
  BACKGROUND_HANDLE: "routecraft.agent.background.handle",
} as const;

declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    /** The background tool handle this exchange was dispatched under. */
    "routecraft.agent.background.handle"?: string;
  }
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
): DeferredFn {
  if (typeof routeId !== "string" || routeId.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `directTool: routeId must be a non-empty string.`,
    });
  }
  return {
    [DEFERRED_FN_BRAND]: true,
    kind: "direct",
    targetId: routeId,
    resolve(ctx, fnId): FnOptions {
      const route = readDirectRoute(ctx, routeId, fnId);
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
      if (overrides?.background === true) {
        const handler = ((input, hctx) =>
          dispatchBackground(
            ctx,
            hctx,
            routeId,
            fnId,
            input,
          )) as FnOptions["handler"];
        return {
          description: `${description}${BACKGROUND_DESCRIPTION_SUFFIX}`,
          input,
          ...(tags && tags.length > 0 ? { tags: [...tags] } : {}),
          handler,
          [FN_BACKGROUND]: true,
        } as FnOptions;
      }
      const handler = ((input, hctx) =>
        dispatchDirect(ctx, hctx, routeId, input)) as FnOptions["handler"];
      return {
        description,
        input,
        ...(tags && tags.length > 0 ? { tags: [...tags] } : {}),
        handler,
      } as FnOptions;
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
    headers[HeadersKeys.AUTH_PRINCIPAL] = cloneFrozenPrincipal(hctx.principal);
  }
  return headers;
}

/**
 * Dispatch the route and return a handle at once. The result or the
 * failure is delivered to the calling session's inbox by the session
 * runtime when the route settles, attributed to the handle.
 *
 * The dispatch id is minted here and carried on the dispatched exchange's
 * headers: a route mints its own exchange id, so the header is what lets
 * an operator join the handle to the run.
 *
 * @internal
 */
async function dispatchBackground<TIn>(
  ctx: CraftContext,
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
      message: `directTool "${routeId}" is declared background: true, which delivers its result to the calling agent's session inbox, and this call has no session. Dispatch the agent with agent(name, { session }), or drop the background flag.`,
    });
  }
  if (hctx.abortSignal.aborted) {
    throw abortError(routeId, hctx.abortSignal.reason);
  }
  const runtime = AgentSessionRuntime.for(ctx);
  const key = { agent: session.agent, session: session.id };
  const dispatchId = randomUUID();
  const handle = `${routeId}:${dispatchId}`;
  const startedAt = new Date();
  await runtime.startBackground(key, {
    handle,
    tool: toolName,
    startedAt: startedAt.toISOString(),
  });
  const headers: ExchangeHeaders = {
    ...dispatchHeaders(hctx),
    [AgentHeadersKeys.BACKGROUND_HANDLE]: handle,
  } as ExchangeHeaders;
  // The settlement writes the session record, and that write can fail
  // (a store outage, a compare-and-swap that never wins); a failure here
  // is logged, because the model is waiting on a result that is now lost
  // and nothing else will say so.
  const settle = (outcome: BackgroundOutcome): void => {
    runtime.settleBackground(key, outcome).catch((err: unknown) => {
      ctx.logger.error(
        { err, agent: key.agent, session: key.session, handle, tool: toolName },
        "Background tool result could not be delivered to the session inbox",
      );
    });
  };
  // Deliberately not awaited: the turn continues, and the settlement is
  // the runtime's business.
  void new CraftClient(ctx).sendDirect(routeId, input, headers).then(
    (result) =>
      settle({
        handle,
        tool: toolName,
        status: "completed",
        result,
        duration: Date.now() - startedAt.getTime(),
      }),
    (err: unknown) =>
      settle({
        handle,
        tool: toolName,
        status: "failed",
        error: {
          ...(rcCodeOf(err) !== undefined ? { rc: rcCodeOf(err)! } : {}),
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name || "Error" : typeof err,
        },
        duration: Date.now() - startedAt.getTime(),
      }),
  );
  return { handle, status: "running" };
}

function readDirectRoute(
  ctx: CraftContext,
  routeId: string,
  fnId: string,
): Capability {
  const capabilities = ctx.capabilities();
  const route = capabilities.find((c) => c.endpoint === routeId);
  if (!route) {
    // An internal route is absent from the capability registry on purpose,
    // so "unknown route id" would be a lie and "register it" wrong advice.
    // This fails context.start(), the same moment a missing route does.
    if (isInternalEndpoint(ctx, routeId)) {
      throw rcError("RC5003", undefined, {
        message: `directTool: route "${routeId}" is declared internal (direct({ internal: true })) and cannot be exposed as a tool (referenced as fn "${fnId}"). Expose a boundary route carrying .input(), .description() and .authorize() instead, and point the tool at that.`,
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
  ctx: CraftContext,
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
  const dispatch = new CraftClient(ctx).sendDirect(
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
