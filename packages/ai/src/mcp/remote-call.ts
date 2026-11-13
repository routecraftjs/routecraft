import {
  callerRefusalOf,
  HeadersKeys,
  isDeferred,
  isDropped,
  principalRef,
  rcCodeOf,
  type CraftContext,
  type Exchange,
  type Principal,
} from "@routecraft/routecraft";
import type { McpRemoteCall, McpRemoteCallSettlement } from "../errors.ts";
import { McpHeadersKeys } from "./types.ts";

/**
 * Record one call toward a remote MCP server's tool: `requested` before it
 * runs and `settled` after, whoever made the call and whichever way it went.
 *
 * The pair is the one record every path to a remote tool leaves. A call that
 * ran a proxy route is recorded once, by that route, with `policy: "route"`.
 * A call that reached a server with no proxy route in front of it (an agent
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
 * The record of a call, with the caller reduced to the reference an audit
 * record keeps. The one place a principal becomes part of the record, so
 * every path records the same subset of it.
 *
 * @internal
 */
export function remoteCall<T extends Omit<McpRemoteCall, "caller">>(
  fields: T,
  principal: Principal | undefined,
): T & Pick<McpRemoteCall, "caller"> {
  return principal === undefined
    ? fields
    : { ...fields, caller: principalRef(principal) };
}

/**
 * Whether a hop to `serverId:remoteTool` is the hop of the proxied call its
 * exchange carries, which the proxy route's source already has on record.
 * The source stamps the client and the remote tool it was called for on the
 * exchange; a hop to anything else reaches a server unjudged and is recorded
 * on its own.
 *
 * @internal
 */
export function isProxiedCallHop(
  exchange: Pick<Exchange, "headers">,
  serverId: string,
  remoteTool: string,
): boolean {
  return (
    exchange.headers[McpHeadersKeys.CLIENT] === serverId &&
    exchange.headers[McpHeadersKeys.TOOL] === remoteTool
  );
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
        refusal === undefined ||
        (refusal.kind === "input" && refusal.in === "headers")
      ) {
        return failure(error);
      }
      return {
        outcome: "refused",
        refusal: refusal.kind === "refused" ? refusal.as : refusal.kind,
      };
    },
  };
}

/**
 * How a call that reached a server with no route in front of it ended.
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
 * The exchange a hop was made from, for the record of that hop.
 *
 * @internal
 */
export function exchangeIdsOf(
  exchange: Exchange,
): Pick<McpRemoteCall, "exchangeId" | "correlationId"> {
  const correlationId = exchange.headers[HeadersKeys.CORRELATION_ID];
  return {
    exchangeId: exchange.id,
    ...(typeof correlationId === "string" ? { correlationId } : {}),
  };
}
