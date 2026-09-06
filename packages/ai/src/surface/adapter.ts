/**
 * `surface()`: the one way a route reaches the person whose turn it is
 * running on.
 *
 * The framework provides the seam and ships none of the capabilities that
 * use it. Reading a file through the editor, running something there,
 * showing a plan: each of those is an ordinary route somebody else owns,
 * with its own guardrails written where a reader of that route can see and
 * change them. That is the same line the framework already draws for tool
 * calls, and it is why there is one adapter here and no `readFile()`
 * beside it.
 *
 * Two roles, because a route does two different things with a surface:
 *
 * - `surface(method, params)` is an enricher. It asks, and the turn waits
 *   for the answer, which is what an approval is.
 * - `surface.notify(update)` is a destination. It tells, and nothing waits.
 */

import {
  getExchangeContext,
  HeadersKeys,
  rcError,
  tagAdapter,
  factoryArgs,
  type Destination,
  type Enricher,
  type CraftContext,
  type Exchange,
  type StepSignalContext,
} from "@routecraft/routecraft";
import "../errors.ts";
import { surfaceRefOf, type AgentSurfaceRef } from "./header.ts";
import { surfaceFor, turnSurfaceOf } from "./registry.ts";
import type {
  AgentSurfaceConnection,
  SurfaceMethod,
  SurfaceRequestParams,
  SurfaceRequestResponses,
  SurfaceUpdate,
} from "./types.ts";

/** A value, or one derived from the exchange the step is running on. */
type Resolvable<T, V> = V | ((exchange: Exchange<T>) => V);

function resolve<T, V>(source: Resolvable<T, V>, exchange: Exchange<T>): V {
  return typeof source === "function"
    ? (source as (exchange: Exchange<T>) => V)(exchange)
    : source;
}

/**
 * Ask the person's surface something, inside the turn.
 *
 * ```ts
 * craft()
 *   .id("read-file")
 *   .from(direct())
 *   .enrich(
 *     surface("fs/read_text_file", (ex) => ({
 *       sessionId: "",
 *       path: (ex.body as { path: string }).path,
 *     })),
 *   );
 * ```
 *
 * `sessionId` is filled in from the running turn, so a route never has to
 * carry it: the surface knows which conversation it is serving.
 *
 * Four ways this fails, and each has a different fix, which is why each
 * has its own code rather than sharing RC5001:
 *
 * - `AI1013`, no surface on this exchange. The route ran outside a
 *   surfaced turn. Guard with `.choice()` and take another path.
 * - `AI1014`, the surface disconnected mid-turn. Nothing to retry against.
 * - `AI1015`, the client never advertised the capability. Configuration.
 * - `AI1016`, the client refused or failed the call. Handle it: a person
 *   saying no arrives this way and is a normal outcome.
 *
 * @template M - The method being called, which fixes the params and the response
 * @template T - Body type available to the params callback
 */
export function surface<M extends SurfaceMethod, T = unknown>(
  method: M,
  params: Resolvable<T, SurfaceRequestParams[M]>,
): Enricher<T, SurfaceRequestResponses[M]> {
  return tagAdapter(
    {
      adapterId: "routecraft.adapter.surface",
      // Which method a step called, on the step's own completion event, so
      // a trace says what the route asked the person for without carrying
      // the answer, which is the person's.
      getMetadata: () => ({ method }),
      fetch: async (
        exchange: Exchange<T>,
        ctx?: StepSignalContext,
      ): Promise<SurfaceRequestResponses[M]> => {
        const { connection, ref } = resolveSurface(exchange, method);
        if (!connection.supports(method)) {
          throw rcError("AI1015", undefined, {
            message: `The ${ref.kind} client serving this turn did not advertise "${connection.capabilityFor(method)}", so it cannot answer "${method}". This is a mismatch between the route and the client, not a fault in either.`,
          });
        }
        // The session is the turn's, never the route's to choose: a route
        // that could name another session could address another person's
        // surface.
        const sent = {
          ...(resolve(params, exchange) as object),
          sessionId: ref.session,
        };
        try {
          return (await connection.request(
            ref.session,
            method,
            sent,
            ctx?.signal,
          )) as SurfaceRequestResponses[M];
        } catch (cause: unknown) {
          throw rcError("AI1016", cause, {
            message: `The ${ref.kind} client serving this turn refused or failed "${method}".`,
          });
        }
      },
    },
    surface,
    factoryArgs(method),
  );
}

/**
 * Tell the person's surface something, without waiting.
 *
 * ```ts
 * .to(surface.notify(() => ({ sessionUpdate: "plan", entries: [] })))
 * ```
 *
 * Same four failures as {@link surface}, except that a notification has no
 * answer, so `AI1016` here means the update could not be handed over
 * rather than that the person refused it.
 *
 * @template T - Body type available to the update callback
 */
surface.notify = function notify<T = unknown>(
  update: Resolvable<T, SurfaceUpdate>,
): Destination<T> {
  return tagAdapter(
    {
      adapterId: "routecraft.adapter.surface",
      getMetadata: () => ({ method: "session/update" }),
      send: async (exchange: Exchange<T>): Promise<void> => {
        const { connection, ref } = resolveSurface(exchange, "session/update");
        try {
          await connection.notify(ref.session, resolve(update, exchange));
        } catch (cause: unknown) {
          throw rcError("AI1016", cause, {
            message: `The ${ref.kind} client serving this turn could not be sent a "session/update".`,
          });
        }
      },
    },
    surface.notify,
    factoryArgs(),
  );
};

/**
 * Whether this exchange is running on a turn with a live surface.
 *
 * The guard a route branches on so the same route works from an editor and
 * from a schedule: `AI1013` is what a route gets for not asking.
 */
export function hasSurface(exchange: Exchange<unknown>): boolean {
  const context = getExchangeContext(exchange);
  if (context === undefined) return false;
  const ref = refFor(context, exchange);
  return ref !== undefined && surfaceFor(context, ref) !== undefined;
}

/**
 * Which surface this exchange belongs to.
 *
 * The header is the first answer and travels with every exchange derived
 * from the turn's own. A route the turn CALLS runs on a fresh exchange
 * that carries the correlation id rather than the whole header bag, so the
 * turn table is the second answer and is what lets a capability three hops
 * from the prompt still reach the person who typed it.
 */
function refFor(
  context: CraftContext,
  exchange: Exchange<unknown>,
): AgentSurfaceRef | undefined {
  const fromHeader = surfaceRefOf(exchange.headers);
  if (fromHeader !== undefined) return fromHeader;
  const correlation = exchange.headers[HeadersKeys.CORRELATION_ID];
  return turnSurfaceOf(
    context,
    typeof correlation === "string" ? correlation : undefined,
  );
}

/**
 * The live connection for this exchange, or the coded refusal that says
 * why there is none.
 *
 * @throws AI1013 when the turn never had a surface
 * @throws AI1014 when it had one and the connection is gone
 */
function resolveSurface(
  exchange: Exchange<unknown>,
  method: string,
): { connection: AgentSurfaceConnection; ref: AgentSurfaceRef } {
  const context = getExchangeContext(exchange);
  const ref = context === undefined ? undefined : refFor(context, exchange);
  if (ref === undefined || context === undefined) {
    throw rcError("AI1013", undefined, {
      message: `surface("${method}") reaches the client running this turn, and this exchange has none. Guard the call with hasSurface(exchange), or dispatch this route from a turn that carries one.`,
    });
  }
  const connection = surfaceFor(context, ref);
  if (connection === undefined) {
    throw rcError("AI1014", undefined, {
      message: `The ${ref.kind} client running this turn disconnected before "${method}" could be sent. There is nothing to retry against on this exchange.`,
    });
  }
  return { connection, ref };
}
