import {
  callerRefusalOf,
  HeadersKeys,
  isDeferred,
  isDropped,
  rcCodeOf,
  type CraftContext,
  type Exchange,
  type Principal,
} from "@routecraft/routecraft";
import type {
  McpRemoteCall,
  McpRemoteCaller,
  McpRemoteCallSettlement,
} from "../errors.ts";

/**
 * Record one call toward a remote MCP server's tool: `requested` before it
 * runs and `settled` after, whoever made the call and whichever way it went.
 *
 * The pair is the one record every path to a remote tool leaves. A call that
 * ran a proxy route is recorded once, by that route, with `policy: "route"`.
 * A call that reached a client with no proxy route in front of it (an agent
 * reference no route covers, a route's own hop, an inline url) is recorded
 * with `policy: "bypassed"`, so the calls no policy judged can be counted
 * rather than inferred from silence.
 *
 * Arguments, results and error text are left out: the record says who
 * called what and how it ended, and is safe to keep.
 *
 * @internal
 */
export async function recordRemoteCall<T>(
  context: CraftContext,
  call: McpRemoteCall,
  run: () => Promise<T>,
  settlementOf: {
    readonly resolved: (result: T) => McpRemoteCallSettlement;
    readonly rejected: (error: unknown) => McpRemoteCallSettlement;
  },
): Promise<T> {
  const started = performance.now();
  context.emit("plugin:mcp:remote:requested", call);
  const settle = (settlement: McpRemoteCallSettlement): void => {
    context.emit("plugin:mcp:remote:settled", {
      ...call,
      ...settlement,
      durationMs: Math.round(performance.now() - started),
    });
  };
  let result: T;
  try {
    result = await run();
  } catch (error) {
    settle(settlementOf.rejected(error));
    throw error;
  }
  settle(settlementOf.resolved(result));
  return result;
}

/**
 * How a call that ran a proxy route ended, read off the route's exchange
 * the way the MCP server reads it: a dropped exchange is a decline, a
 * `Deferred` body is a parked run, anything else is the answer.
 *
 * @internal
 */
export function routeSettlement(
  routeId: string,
  principal: Principal | undefined,
): {
  readonly resolved: (exchange: Exchange) => McpRemoteCallSettlement;
  readonly rejected: (error: unknown) => McpRemoteCallSettlement;
} {
  return {
    resolved: (exchange) => {
      if (isDropped(exchange)) return { outcome: "declined" };
      if (isDeferred(exchange.body)) return { outcome: "deferred" };
      return { outcome: "completed" };
    },
    rejected: (error) => {
      const refusal = callerRefusalOf(error, {
        routeId,
        principal,
        credentialCouldHelp: principal === undefined,
      });
      // A caller sends no headers, so a headers refusal is the route's own.
      if (
        refusal !== undefined &&
        !(refusal.kind === "input" && refusal.in === "headers")
      ) {
        return {
          outcome: "refused",
          refusal: refusal.kind === "refused" ? refusal.as : refusal.kind,
        };
      }
      return failure(error);
    },
  };
}

/**
 * How a call that reached a client with no route in front of it ended.
 *
 * @internal
 */
export const directSettlement = {
  resolved: (): McpRemoteCallSettlement => ({ outcome: "completed" }),
  rejected: failure,
} as const;

/** A remote's own `isError` answer apart from a call that broke on the way. */
function failure(error: unknown): McpRemoteCallSettlement {
  const code = rcCodeOf(error);
  if (code === "AI2003") return { outcome: "remote-error", code };
  return code === undefined
    ? { outcome: "failed" }
    : { outcome: "failed", code };
}

/**
 * Who a call is recorded as made by: the identity, never the credential or
 * the claims behind it.
 *
 * @internal
 */
export function remoteCallerOf(
  principal:
    Readonly<Pick<Principal, "subject" | "issuer" | "clientId">> | undefined,
): McpRemoteCaller | undefined {
  if (principal === undefined) return undefined;
  return {
    subject: principal.subject,
    ...(principal.issuer !== undefined ? { issuer: principal.issuer } : {}),
    ...(principal.clientId !== undefined
      ? { clientId: principal.clientId }
      : {}),
  };
}

/** The principal a door or an agent put on a call's headers. */
export function principalOnHeaders(
  headers: Record<string, unknown> | undefined,
): Principal | undefined {
  return headers?.[HeadersKeys.AUTH_PRINCIPAL] as Principal | undefined;
}
