import type { CraftContext } from "../context.ts";
import { rcError } from "../error.ts";
import {
  decodeCursor,
  encodeCursor,
  parsePageQuery,
} from "../plugins/ops/pagination.ts";
import { registerOpsResource } from "../plugins/ops/store.ts";
import type { CursorScope } from "../plugins/ops/pagination.ts";
import type { OpsDeferralSummary, OpsPage } from "../plugins/ops/types.ts";
import { DEFERRAL_RUNTIME } from "./runtime-key.ts";
import { summariseDeferral } from "./types.ts";
import type {
  DeferralListCursor,
  DeferralState,
  DeferralStore,
  DeferralSummary,
} from "./types.ts";

/**
 * The management listing of what an instance is waiting on.
 *
 * Everything a reader needs is already on the record: what the work waits
 * for, when it was deferred, when it comes due, whether a delivery claim
 * is outstanding, and how a settled one ended. What was missing until now
 * is a surface that renders it, so a deferral could only be seen by
 * invoking the route that produced it.
 *
 * Contributed through the same seam `@routecraft/ai` uses for
 * `agent-sessions`, rather than served by the ops mount itself, because
 * the mount owns `routes` and `events` and nothing else. Registration is
 * inert until an ops mount exists.
 */

/** The path segment under `/ops`. */
const DEFERRALS_RESOURCE = "deferrals";

/**
 * What a bare listing shows.
 *
 * Waiting, because the question an operator opens this with is what is
 * still owed an answer, and a settled deferral is history. `?state=settled`
 * asks for the history, and `?state=all` for both.
 */
const DEFAULT_STATE: DeferralState = "waiting";

/** Page size the store is asked for when the caller names none. */
const DEFAULT_LIMIT = 50;

/**
 * The keyset the ops cursor carries for this collection, rendered into
 * the opaque string the shared helpers page on.
 *
 * `deferredAt` is an epoch millisecond count rather than an ISO string so
 * the key cannot carry a second rendering of the same instant, and the
 * separator is a character no deferral id contains, since an id is
 * `{uuid}#{sequence}`.
 */
const KEY_SEPARATOR = "|";

function encodeKey(summary: DeferralSummary): string {
  return `${String(summary.deferredAt.getTime())}${KEY_SEPARATOR}${summary.id}`;
}

/**
 * Render a store's summary onto the wire.
 *
 * The one difference is the timestamps: a store answers in `Date` and the
 * wire has none, so they are rendered here rather than left for
 * `JSON.stringify` to do silently against a type that claims otherwise.
 * `by` is narrowed to the fields a listing may show; `actorSubject` is
 * part of the audit record and not part of this answer.
 */
function onWire(summary: DeferralSummary): OpsDeferralSummary {
  return {
    id: summary.id,
    routeId: summary.routeId,
    state: summary.state,
    waitingFor: summary.waitingFor,
    claimed: summary.claimed,
    deferredAt: summary.deferredAt.toISOString(),
    ...(summary.expiresAt !== undefined
      ? { expiresAt: summary.expiresAt.toISOString() }
      : {}),
    ...(summary.outcome !== undefined
      ? {
          outcome: {
            kind: summary.outcome.kind,
            at: summary.outcome.at.toISOString(),
            ...(summary.outcome.reason !== undefined
              ? { reason: summary.outcome.reason }
              : {}),
            ...(summary.outcome.by !== undefined
              ? {
                  by: {
                    subject: summary.outcome.by.subject,
                    ...(summary.outcome.by.issuer !== undefined
                      ? { issuer: summary.outcome.by.issuer }
                      : {}),
                    ...(summary.outcome.by.clientId !== undefined
                      ? { clientId: summary.outcome.by.clientId }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Read a cursor key back, refusing anything the store would have to guess
 * at. A malformed key is the caller's, and `RC5059` is the code the mount
 * answers as a 400 naming the rule, exactly as it does for a bad `limit`.
 */
function decodeKey(key: string): DeferralListCursor {
  const at = key.indexOf(KEY_SEPARATOR);
  const millis = at <= 0 ? Number.NaN : Number(key.slice(0, at));
  const id = at <= 0 ? "" : key.slice(at + 1);
  if (!Number.isFinite(millis) || id.length === 0) {
    throw rcError("RC5059", undefined, {
      message:
        "The cursor is malformed. Pass back the `nextCursor` from the previous page unchanged, or omit it to start from the first page.",
    });
  }
  return { deferredAt: new Date(millis), id };
}

/**
 * Bind a cursor to the filter that produced it.
 *
 * The route listing's fingerprint is built from its own filter fields, and
 * a contributed resource renders its own the same way: a fixed field order
 * with an absent field as `null`, so the same filter written two ways
 * produces one fingerprint and a cursor survives a client that reorders
 * its query string.
 */
function scopeOf(state: DeferralState | "all", routeId?: string): CursorScope {
  return { fingerprint: JSON.stringify(["deferrals", state, routeId ?? null]) };
}

/**
 * The state a query asks for. `all` is a filter value rather than an
 * omitted parameter so a cursor can be bound to it: "no state given" and
 * "both states" would otherwise fingerprint differently while paging the
 * same result set.
 */
function stateOf(raw: string | undefined): DeferralState | "all" {
  if (raw === undefined) return DEFAULT_STATE;
  if (raw === "waiting" || raw === "settled" || raw === "all") return raw;
  throw rcError("RC5059", undefined, {
    message: `The state filter must be "waiting", "settled" or "all"; received ${JSON.stringify(raw)}.`,
  });
}

/**
 * The store's listing, or a refusal naming what is missing.
 *
 * A store supplied through `deferral: { store }` is the caller's own and
 * may have been written against an earlier contract. Answering an empty
 * page would be indistinguishable from an instance with nothing deferred,
 * which is the one answer this surface must never give wrongly.
 *
 * @throws RC5065 when the configured store does not implement `list`
 */
function listingOf(store: DeferralStore): DeferralStore["list"] {
  if (typeof store.list !== "function") {
    throw rcError("RC5065", undefined, {
      message:
        'The deferral store configured on this context does not implement "list", which GET /ops/deferrals reads. Implement DeferralStore.list, or use one of the shipped backends (sqlite or memory).',
    });
  }
  return store.list.bind(store);
}

/**
 * Contribute `GET /ops/deferrals` to the management API.
 *
 * Called from the deferral plugin's `apply()`, so a context that
 * configured deferral has the listing and one that did not has no
 * resource at all rather than an empty one. A second registration of the
 * name is refused by the seam, which is what a context carrying two
 * deferral plugins deserves.
 *
 * @internal
 */
export function registerDeferralsResource(ctx: CraftContext): void {
  registerOpsResource<OpsDeferralSummary>(ctx, {
    name: DEFERRALS_RESOURCE,
    async list(query): Promise<OpsPage<OpsDeferralSummary>> {
      const runtime = ctx.getStore(DEFERRAL_RUNTIME);
      if (runtime === undefined) return { items: [] };
      const list = listingOf(runtime.store);
      const state = stateOf(query["state"]);
      const routeId = query["route"];
      const scope = scopeOf(state, routeId);
      const page = parsePageQuery(query);
      const limit = page.limit ?? DEFAULT_LIMIT;
      const after =
        page.after === undefined
          ? undefined
          : decodeKey(decodeCursor(page.after, scope));

      // One more than the page, so "is there another page" is answered by
      // the read rather than by a second query or by a count that a
      // concurrent defer would invalidate between the two.
      const rows = await list({
        ...(state === "all" ? {} : { state }),
        ...(routeId !== undefined ? { routeId } : {}),
        limit: limit + 1,
        ...(after !== undefined ? { after } : {}),
      });
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return rows.length > limit && last !== undefined
        ? {
            items: items.map(onWire),
            nextCursor: encodeCursor(encodeKey(last), scope),
          }
        : { items: items.map(onWire) };
    },
    async describe(segments): Promise<OpsDeferralSummary | undefined> {
      // One segment: a deferral is named by its id alone. The id contains
      // a `#`, which the mount has already decoded out of the path.
      if (segments.length !== 1) return undefined;
      const runtime = ctx.getStore(DEFERRAL_RUNTIME);
      if (runtime === undefined) return undefined;
      // Through `get` rather than the listing, because addressing one
      // record by id is what `get` is, and the summary projection is the
      // same either way. The stored exchange is dropped here rather than
      // rendered, as it is for the collection.
      const deferral = await runtime.store.get(segments[0]!);
      return deferral === undefined
        ? undefined
        : onWire(summariseDeferral(deferral));
    },
  });
}
