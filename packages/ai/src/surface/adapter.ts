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
  anySignal,
  formatSchemaIssues,
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
import {
  pinSurface,
  pinnedSurfaceOf,
  registerCleanup,
  turnSignalOf,
} from "./cancellation.ts";
import { surfaceRefOf, type AgentSurfaceRef } from "./header.ts";
import {
  PERMISSION_REFUSED,
  permissionSelectionIssue,
  responseCheck,
  updateCheck,
  type ProtocolIssue,
} from "./protocol.ts";
import { surfaceFor, turnSurfaceOf } from "./registry.ts";
import { SurfaceDisconnected } from "./errors.ts";
import {
  withSession,
  type AgentSurfaceConnection,
  type SurfaceMethod,
  type SurfaceRequest,
  type SurfaceRequestParams,
  type SurfaceRequestResponses,
  type SurfaceUpdate,
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
 *       path: (ex.body as { path: string }).path,
 *     })),
 *   );
 * ```
 *
 * The protocol's `sessionId` is not part of the params: it is filled in
 * from the running turn, which is the only conversation a route can mean,
 * and a callback that names one does not compile.
 *
 * Five ways this fails, and each has a different fix, which is why each
 * has its own code rather than sharing RC5001:
 *
 * - `AI1013`, no surface on this exchange. The route ran outside a
 *   surfaced turn. Guard with `.choice()` and take another path.
 * - `AI1014`, the surface disconnected, before the call or while it was
 *   outstanding. Nothing to retry against: a reconnected editor is a new
 *   surface and the call is never re-sent.
 * - `AI1015`, the client never advertised the capability. Configuration.
 * - `AI1016`, the client refused or failed the call, or the turn was
 *   cancelled: a call outstanding at the cancel is cancelled at the
 *   editor, and one made after it is refused without being sent. Handle
 *   it: a person saying no arrives this way and is a normal outcome.
 * - `AI1018`, the client answered with something that is not the
 *   protocol's shape for the method. Nothing malformed reaches the route.
 *
 * `session/request_permission` is the exception to the last: an answer
 * that cannot be trusted, malformed or naming an option that was never
 * offered, reaches the route as the protocol's own `cancelled` outcome
 * rather than as an error, because the one message whose job is to say no
 * must fail closed, and a route reads a refusal the same way whichever
 * way it came.
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
        const { context, connection, ref } = resolveSurface(
          exchange,
          `surface("${method}")`,
        );
        assertSupported(connection, ref, method);
        // Nothing new goes to the editor once the person has said stop.
        // What must reach them after that is registered beforehand.
        const turn = turnSignalOf(context, ref.session);
        if (turn.aborted) {
          throw rcError("AI1016", undefined, {
            message: `The turn running this route was cancelled, so "${method}" was not sent. Anything that must reach the ${ref.kind} client after a cancel is registered beforehand with surface.onCancel().`,
          });
        }
        const sent = withSession(resolve(params, exchange), ref);
        // The check is loaded before the call goes out, so a schema that
        // cannot be built fails here rather than after the person answered.
        const check = await responseCheck(method);
        let answer: unknown;
        try {
          answer = await connection.request(
            ref.session,
            method,
            sent,
            anySignal(ctx?.signal, turn),
          );
        } catch (cause: unknown) {
          if (cause instanceof SurfaceDisconnected) {
            throw rcError("AI1014", cause.cause, {
              message: `The ${ref.kind} client running this turn disconnected while "${method}" was outstanding. Any answer the person gave is lost with the connection, and there is nothing to retry against on this exchange.`,
            });
          }
          if (turn.aborted) {
            throw rcError("AI1016", cause, {
              message: `The turn running this route was cancelled while "${method}" was outstanding, and the call was cancelled with it.`,
            });
          }
          throw rcError("AI1016", cause, {
            message: `The ${ref.kind} client serving this turn refused or failed "${method}".`,
          });
        }
        const issues =
          (await check(answer)) ??
          (method === "session/request_permission"
            ? optional(permissionSelectionIssue(sent, answer))
            : undefined);
        if (issues === undefined) return answer as SurfaceRequestResponses[M];
        const rendered = formatSchemaIssues(issues);
        if (method === "session/request_permission") {
          getExchangeContext(exchange)?.logger.warn(
            {
              method,
              session: ref.session,
              issues: rendered,
              source: "surface",
            },
            "The editor's permission answer could not be trusted and was treated as a refusal",
          );
          return PERMISSION_REFUSED as SurfaceRequestResponses[M];
        }
        throw rcError("AI1018", new Error(rendered), {
          message: `The ${ref.kind} client serving this turn answered "${method}" with something that is not the protocol's response shape: ${rendered}.`,
        });
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
 * Same failures as {@link surface}, except that a notification has no
 * answer, so `AI1016` here means the update could not be handed over
 * rather than that the person refused it, and the shape checked is the
 * one the route built: an update that is not a `session/update` the
 * protocol defines is `AI1019` and is never sent.
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
        const { context, connection, ref } = resolveSurface(
          exchange,
          "surface.notify()",
        );
        // Dropped rather than refused: a notification has no answer, so a
        // route that keeps running after a stop has nothing to handle, and
        // the rule is the one `surface()` enforces. Nothing new reaches a
        // person who said stop.
        if (turnSignalOf(context, ref.session).aborted) return;
        const built = resolve(update, exchange);
        const issues = await (await updateCheck())(built);
        if (issues !== undefined) {
          const rendered = formatSchemaIssues(issues);
          throw rcError("AI1019", new Error(rendered), {
            message: `surface.notify() built an update that is not a "session/update" the protocol defines: ${rendered}.`,
          });
        }
        try {
          await connection.notify(ref.session, built);
        } catch (cause: unknown) {
          if (cause instanceof SurfaceDisconnected) {
            throw rcError("AI1014", cause.cause, {
              message: `The ${ref.kind} client running this turn disconnected before a "session/update" could be handed over.`,
            });
          }
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
 * Register what to send the person's surface if the turn is cancelled
 * while this exchange is still running. Returns the call that withdraws
 * the registration, for the route that did its own cleanup.
 *
 * ```ts
 * const created = await surface("terminal/create", { command }).fetch(ex);
 * const release = surface.onCancel(ex, [
 *   { method: "terminal/kill", params: { terminalId: created.terminalId } },
 *   { method: "terminal/release", params: { terminalId: created.terminalId } },
 * ]);
 * try {
 *   await surface("terminal/wait_for_exit", { terminalId }).fetch(ex);
 * } finally {
 *   release();
 *   await surface("terminal/release", { terminalId }).fetch(ex);
 * }
 * ```
 *
 * A route the turn called keeps running after the person presses stop,
 * but the surface stops taking its calls: the request it has outstanding
 * is cancelled at the editor, and a new one is refused. That is the right
 * default for a turn the person ended, and it leaves the terminal the
 * route created running in their editor with nothing to close it. This is
 * the exception, bounded to what was declared before the cancel: the
 * framework sends these, in order, after the turn has answered
 * `cancelled`, each under a short deadline, and logs rather than throws
 * when one fails. A registration is dropped when the exchange completes,
 * so a cancel later in the conversation cannot replay a release the route
 * already did itself.
 *
 * Every method is checked against what the client advertised here rather
 * than at cleanup time, so a route learns of the mismatch while it can
 * still act on it: `AI1015`, as for a call.
 */
surface.onCancel = function onCancel(
  exchange: Exchange<unknown>,
  requests: readonly SurfaceRequest[],
): () => void {
  const { connection, ref } = resolveSurface(exchange, "surface.onCancel()");
  for (const request of requests)
    assertSupported(connection, ref, request.method);
  return registerCleanup(exchange, ref, connection, requests);
};

/** @throws AI1015 when the client never advertised what the method needs */
function assertSupported(
  connection: AgentSurfaceConnection,
  ref: AgentSurfaceRef,
  method: string,
): void {
  if (connection.supports(method)) return;
  throw rcError("AI1015", undefined, {
    message: `The ${ref.kind} client serving this turn did not advertise "${connection.capabilityFor(method)}", so it cannot answer "${method}". This is a mismatch between the route and the client, not a fault in either.`,
  });
}

/** A single issue as the issue list a check returns, or nothing. */
function optional(
  issue: ProtocolIssue | undefined,
): readonly ProtocolIssue[] | undefined {
  return issue === undefined ? undefined : [issue];
}

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
 * What the exchange resolved before is asked first: a surface, once
 * resolved, stays the exchange's for its life, so a route that had one is
 * never told it did not, however the turn ended. The mount forgets a
 * turn's surface when the turn ends, and the routes it called are still
 * running then.
 *
 * Then the turn table, because the mount registered what is in it
 * against a correlation id it minted. The header is data on an exchange,
 * and an exchange is something any route can build: preferring it would
 * let a carried or copied header decide which person a privileged call
 * reaches. Asking the table first means the answer comes from what the
 * runtime knows rather than from what the exchange claims.
 *
 * The header is still the fallback, and it is what a step on the turn's
 * own route resolves through once the turn's table entry has gone. Both
 * agree for the turn that minted them; they can only diverge on an
 * exchange that outlived or never belonged to its turn, and that is
 * exactly the case worth resolving conservatively.
 */
function refFor(
  context: CraftContext,
  exchange: Exchange<unknown>,
): AgentSurfaceRef | undefined {
  const pinned = pinnedSurfaceOf(context, exchange.id);
  if (pinned !== undefined) return pinned;
  const correlation = exchange.headers[HeadersKeys.CORRELATION_ID];
  const fromTurn = turnSurfaceOf(
    context,
    typeof correlation === "string" ? correlation : undefined,
  );
  return fromTurn ?? surfaceRefOf(exchange.headers);
}

/**
 * The live connection for this exchange, or the coded refusal that says
 * why there is none. A surface found is pinned to the exchange, so every
 * later call on it resolves the same one.
 *
 * @param call - The call being made, as the refusal names it
 * @throws AI1013 when the turn never had a surface
 * @throws AI1014 when it had one and the connection is gone
 */
function resolveSurface(
  exchange: Exchange<unknown>,
  call: string,
): {
  context: CraftContext;
  connection: AgentSurfaceConnection;
  ref: AgentSurfaceRef;
} {
  const context = getExchangeContext(exchange);
  const ref = context === undefined ? undefined : refFor(context, exchange);
  if (ref === undefined || context === undefined) {
    throw rcError("AI1013", undefined, {
      message: `${call} reaches the client running this turn, and this exchange has none. Guard the call with hasSurface(exchange), or dispatch this route from a turn that carries one.`,
    });
  }
  const connection = surfaceFor(context, ref);
  if (connection === undefined) {
    throw rcError("AI1014", undefined, {
      message: `The ${ref.kind} client running this turn disconnected before ${call} could reach it. There is nothing to retry against on this exchange.`,
    });
  }
  pinSurface(context, exchange.id, ref);
  return { context, connection, ref };
}
