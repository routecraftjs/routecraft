/**
 * The management API's handlers, with no transport in sight.
 *
 * Every function here takes decoded arguments and returns decoded results.
 * The ops mount (`mount.ts`) is a thin door that turns a `Request` into
 * these calls and their results into a `Response`, and it is the only file
 * in this surface that knows HTTP exists. That separation is what lets the
 * console's control API (#494) grow over the same handlers later without
 * protocol rework, and it is why a resource-shaped door did not become a
 * licence to move logic into it.
 */

import { CraftClient } from "../../client";
import { isInternalEndpoint } from "../../capabilities";
import type { CraftContext } from "../../context";
import { rcError } from "../../error";
import { HeadersKeys } from "../../exchange";
import type { ExchangeHeaders } from "../../exchange";
import { rcCodeOf } from "../../brand";
import type { Principal } from "../../auth/types";
import type { Capability } from "../../capabilities";
import type { RouteDefinition } from "../../route";
import { getAdapterLabel } from "../../types";
import type { Adapter } from "../../types";
import { isSuspended } from "../../suspension/suspended";
import {
  renderJsonSchemaArm,
  standardExtensionOf,
} from "../../shared/standard-schema";
import { decodeCursor, takePage } from "./pagination";
import { safeStringify } from "../../shared/safe-json.ts";
import { compareCodeUnits } from "../../shared/compare";
import { OPS_RESOURCES } from "./store";
import type {
  OpsDispatchOutcome,
  OpsEventTailItem,
  OpsPage,
  OpsResource,
  OpsRouteDetail,
  OpsRouteFilter,
  OpsRouteQuery,
  OpsRouteSchemas,
  OpsRouteSummary,
} from "./types";

/**
 * JSON Schema dialect asked of a schema library's producer.
 *
 * Pinned so two instances of this API describe the same route identically.
 * Unrelated to the suspension descriptor's constant of the same value:
 * that one is folded into a stored hash and must not move, this one is
 * descriptive, and sharing a single mutable constant between them would
 * couple a display choice to every parked exchange's digest.
 */
const JSON_SCHEMA_TARGET = "draft-2020-12";

/** What the management handlers need from a running context. */
export interface ManagementApi {
  listRoutes(query: OpsRouteQuery): OpsPage<OpsRouteSummary>;
  describeRoute(id: string): OpsRouteDetail | undefined;
  dispatch(
    id: string,
    body: unknown,
    principal: Principal | undefined,
  ): Promise<OpsDispatchOutcome>;
  tailEvents(signal: AbortSignal): AsyncIterable<OpsEventTailItem>;
  /**
   * A contributed resource by name, read per request so a plugin applied
   * after the ops mount is served too. `undefined` for a name nothing
   * contributed, which the mount answers as 404 like any unknown path.
   */
  resource(name: string): OpsResource | undefined;
}

/**
 * How many events the tail holds for a reader that has fallen behind.
 *
 * The bus emits synchronously on the route's own hot path, so the tail can
 * never block it: it buffers and moves on. A bound is what keeps a reader
 * that stopped reading from growing that buffer until the process dies,
 * and dropping the oldest is the right end to lose, because a live tail is
 * watched for what is happening now.
 */
const TAIL_BUFFER = 256;

/**
 * How many bytes of rendered frames the tail holds for the same reader.
 *
 * The count bound alone bounds nothing about size: an event whose details
 * carry a large error or a large body renders to a large frame, and a few
 * hundred of those is a few hundred times whatever the largest one is.
 * Streaming slots are per-server, so that ceiling multiplies by every tail
 * an operator has open. Bytes and count are both evicted oldest-first, and
 * both feed the same dropped marker the reader already sees.
 */
const TAIL_BUFFER_BYTES = 1_048_576;

/**
 * How long the tail stays silent before putting a comment on the wire.
 *
 * An idle app emits nothing, and a proxy between the operator and the
 * process reaps a connection that says nothing for long enough. The comment
 * is the SSE spec's own no-op, ignored by every conforming client.
 */
const TAIL_HEARTBEAT_MS = 30_000;

/**
 * What one queued frame costs the byte budget.
 *
 * UTF-16 code units rather than encoded bytes: the frame is not encoded
 * until the reader takes it, and an exact count would mean encoding every
 * event on the bus's hot path to bound a buffer. The two agree for ASCII
 * and stay within a small factor otherwise, which is all a ceiling needs.
 */
function frameBytes(item: OpsEventTailItem): number {
  return item.kind === "event" ? item.data.length : 0;
}

/**
 * Build the management handlers over a live context.
 *
 * Routes and capabilities are read per call rather than captured, because
 * both change as routes start and stop and a snapshot taken at mount time
 * would describe the instance as it was at boot.
 */
export function createManagementApi(ctx: CraftContext): ManagementApi {
  const client = new CraftClient(ctx);

  /**
   * The dispatchable set, keyed by raw route id.
   *
   * `direct()` writes the capability registry when it subscribes, and that
   * registration IS the door a dispatch goes through, so dispatchability
   * is observed here rather than inferred from a route's source shape. It
   * also carries the title, description, schemas and tags a route declared,
   * which is what makes this listing useful to a human.
   */
  const capabilityIndex = (): Map<string, Capability> =>
    new Map(ctx.capabilities().map((entry) => [entry.endpoint, entry]));

  const summaries = (): OpsRouteSummary[] => {
    const capabilities = capabilityIndex();
    return ctx
      .getRoutes()
      .map((route) => summarise(ctx, route.definition, capabilities))
      .sort((left, right) => compareCodeUnits(left.id, right.id));
  };

  return {
    listRoutes(query: OpsRouteQuery): OpsPage<OpsRouteSummary> {
      const filter: OpsRouteFilter = {
        ...(query.dispatchable !== undefined
          ? { dispatchable: query.dispatchable }
          : {}),
        ...(query.id !== undefined ? { id: query.id } : {}),
        ...(query.source !== undefined ? { source: query.source } : {}),
      };
      const matched = summaries().filter((route) => matches(route, filter));
      const after =
        query.after === undefined
          ? undefined
          : decodeCursor(query.after, filter);
      const page = takePage(matched, filter, query.limit, after);
      return page.nextCursor === undefined
        ? { items: page.items }
        : { items: page.items, nextCursor: page.nextCursor };
    },

    /**
     * Tail every event the context emits until the caller goes away.
     *
     * Subscribes to the bus catch-all and hands items over a bounded
     * buffer, because `emit` runs on the caller's stack: a tail that awaited
     * its reader there would put an operator's network back-pressure inside
     * a route step.
     *
     * The generator parks on a promise rather than polling, and the signal
     * resolves it. Cancelling the response is not enough on its own: an
     * async generator delivers a queued `return()` only after the pending
     * `next()` settles, so a tail with nothing to yield would sit on that
     * promise forever with its subscription still live.
     */
    async *tailEvents(signal: AbortSignal): AsyncIterable<OpsEventTailItem> {
      const queue: OpsEventTailItem[] = [];
      let queuedBytes = 0;
      let dropped = 0;
      let wake: (() => void) | undefined;

      // The tail is in-flight work for as long as it runs, and a graceful
      // close would otherwise wait out its whole window on a stream that
      // ends the moment it is asked to. `context:stopping` arrives on the
      // bus this is already reading, so it needs no second channel: the
      // event is delivered, and then the tail closes behind it.
      let stopping = false;
      const unsubscribe = ctx.on("*", (payload) => {
        const item: OpsEventTailItem = {
          kind: "event",
          name: payload._event,
          // Rendered here, on the emit, rather than held by reference until
          // the reader takes it: see OpsEventTailItem.data. `_snapshot`
          // sub-payloads go with it, because they exist so a surface that was
          // not asked to capture payloads does not, and a tail an operator
          // opened is not that asking.
          data: safeStringify(
            {
              event: payload._event,
              ts: payload.ts,
              contextId: payload.contextId,
              details: payload.details,
            },
            { dropSnapshot: true },
          ),
        };
        const size = frameBytes(item);
        // An oversized frame still goes on: evicting the whole buffer and
        // then refusing it would leave the reader nothing at all. It is the
        // next push that evicts it.
        while (
          queue.length > 0 &&
          (queue.length >= TAIL_BUFFER ||
            queuedBytes + size > TAIL_BUFFER_BYTES)
        ) {
          queuedBytes -= frameBytes(queue.shift()!);
          dropped++;
        }
        queue.push(item);
        queuedBytes += size;
        if (payload._event === "context:stopping") stopping = true;
        wake?.();
      });
      const onAbort = (): void => wake?.();
      signal.addEventListener("abort", onAbort);

      try {
        while (!signal.aborted) {
          if (queue.length === 0) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await new Promise<void>((resolve) => {
              wake = resolve;
              timer = setTimeout(resolve, TAIL_HEARTBEAT_MS);
            });
            if (timer !== undefined) clearTimeout(timer);
            wake = undefined;
            if (queue.length === 0 && !signal.aborted)
              yield { kind: "heartbeat" };
            continue;
          }
          if (dropped > 0) {
            const count = dropped;
            dropped = 0;
            yield { kind: "dropped", count };
          }
          const next = queue.shift()!;
          queuedBytes -= frameBytes(next);
          yield next;
          if (stopping && queue.length === 0) return;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        unsubscribe();
      }
    },

    resource(name: string): OpsResource | undefined {
      return ctx.getStore(OPS_RESOURCES)?.get(name);
    },

    describeRoute(id: string): OpsRouteDetail | undefined {
      const capabilities = capabilityIndex();
      const route = ctx
        .getRoutes()
        .find((candidate) => candidate.definition.id === id);
      if (!route) return undefined;
      return detail(ctx, route.definition, capabilities);
    },

    async dispatch(
      id: string,
      body: unknown,
      principal: Principal | undefined,
    ): Promise<OpsDispatchOutcome> {
      const capabilities = capabilityIndex();
      const route = ctx
        .getRoutes()
        .find((candidate) => candidate.definition.id === id);
      if (!route) {
        throw rcError("RC5004", undefined, {
          message: `No route "${id}" is registered in this instance.`,
        });
      }
      if (!capabilities.has(id)) {
        // Two different refusals behind one absence: a route that declared
        // `direct({ internal: true })` HAS a direct source, so telling its
        // caller to add one would be wrong advice. The internal registry is
        // what remembers the difference.
        if (isInternalEndpoint(ctx, id)) {
          throw rcError("RC5060", undefined, {
            message: `Route "${id}" is declared internal (direct({ internal: true })) and not dispatchable. It is only composable from another route; dispatch to a boundary route that fronts it instead.`,
          });
        }
        throw rcError("RC5060", undefined, {
          message: `Route "${id}" has no dispatch door: its sources are ${
            sourceKinds(route.definition).join(", ") || "(none)"
          }, and only a direct() ingress makes a route id dispatchable. Add .from(direct()) to the route, or dispatch to one that has it.`,
        });
      }

      // The principal is passed through exactly as the mount's validator
      // minted it, on the header the framework itself uses. There is no
      // synthetic operator identity and no bypass: the full pre-from chain
      // runs, so a downstream .authorize() cannot tell an operator dispatch
      // from any other authenticated caller, which is the entire point.
      const headers: ExchangeHeaders =
        principal === undefined
          ? {}
          : ({ [HeadersKeys.AUTH_PRINCIPAL]: principal } as ExchangeHeaders);

      try {
        const result = await client.sendDirect(id, body, headers);
        if (isSuspended(result)) {
          return { outcome: "suspended", suspension: result };
        }
        return { outcome: "completed", body: result };
      } catch (error: unknown) {
        // A drop is a terminal outcome, not a fault: a filter said no and
        // there is no response body. Reporting it as a failure would tell
        // an operator to go looking for a broken step.
        if (rcCodeOf(error) === "RC5031") {
          return {
            outcome: "dropped",
            message: (error as Error).message,
          };
        }
        throw error;
      }
    },
  };
}

/** Source kinds a route declares, in declaration order. */
function sourceKinds(definition: RouteDefinition): string[] {
  return definition.sources.map(
    (source) => getAdapterLabel(source as Adapter) ?? "inline",
  );
}

function summarise(
  ctx: CraftContext,
  definition: RouteDefinition,
  capabilities: Map<string, Capability>,
): OpsRouteSummary {
  const capability = capabilities.get(definition.id);
  const discovery = definition.discovery;
  const title = capability?.title ?? discovery?.title;
  const description = capability?.description ?? discovery?.description;
  const tags = capability?.tags ?? discovery?.tags;
  return {
    id: definition.id,
    dispatchable: capabilities.has(definition.id),
    enabled: ctx.isRouteEnabled(definition.id),
    sources: sourceKinds(definition),
    requiresPrincipal: definition.requiresPrincipal === true,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(tags !== undefined && tags.length > 0 ? { tags: [...tags] } : {}),
  };
}

function detail(
  ctx: CraftContext,
  definition: RouteDefinition,
  capabilities: Map<string, Capability>,
): OpsRouteDetail {
  const capability = capabilities.get(definition.id);
  const discovery = definition.discovery;
  const input = renderSchemas(capability?.input ?? discovery?.input, "input");
  const output = renderSchemas(
    capability?.output ?? discovery?.output,
    "output",
  );
  return {
    ...summarise(ctx, definition, capabilities),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

/**
 * Render a route's declared schemas to JSON Schema, when the library
 * exposes the non-standard extension.
 *
 * The preferred arm follows the direction the schema is used in: what a
 * caller must SEND is the input schema's input arm, and what it receives
 * is the output schema's output arm. The other arm is a fallback rather
 * than an equal, because for a transforming schema the two differ and
 * showing the wrong one would document a request shape nobody may send.
 */
function renderSchemas(
  schemas: { body?: unknown; headers?: unknown } | undefined,
  direction: "input" | "output",
): OpsRouteSchemas | undefined {
  if (!schemas) return undefined;
  const body = renderSchema(schemas.body, direction);
  const headers = renderSchema(schemas.headers, direction);
  if (body === undefined && headers === undefined) return undefined;
  return {
    ...(body !== undefined ? { body } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
}

function renderSchema(schema: unknown, direction: "input" | "output"): unknown {
  if (schema === undefined || schema === null) return undefined;
  const standard = standardExtensionOf(schema);
  const arms =
    direction === "input"
      ? [standard?.jsonSchema?.input, standard?.jsonSchema?.output]
      : [standard?.jsonSchema?.output, standard?.jsonSchema?.input];
  return (
    renderJsonSchemaArm(arms[0], JSON_SCHEMA_TARGET) ??
    renderJsonSchemaArm(arms[1], JSON_SCHEMA_TARGET)
  );
}

function matches(route: OpsRouteSummary, filter: OpsRouteFilter): boolean {
  if (
    filter.dispatchable !== undefined &&
    route.dispatchable !== filter.dispatchable
  ) {
    return false;
  }
  // Exact, not a prefix: a prefix match makes the result set of a cursor
  // hard for a caller to reason about, and an id is a name rather than a
  // search term.
  if (filter.id !== undefined && route.id !== filter.id) return false;
  if (filter.source !== undefined && !route.sources.includes(filter.source)) {
    return false;
  }
  return true;
}
