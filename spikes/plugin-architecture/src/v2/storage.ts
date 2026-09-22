import { Database } from "bun:sqlite";
import {
  port,
  CONTINUATIONS,
  DEFERRAL_SEQUENCE,
  type ContinuationRecord,
  type ContinuationStore,
  type Exchange,
  type PluginContext,
  type ExpiredEntry,
  Fault,
} from "./contracts.ts";
import { fingerprint } from "./codec.ts";
import {
  infrastructure,
  type Family,
  type Plugin,
  type Cursor,
  type Chain,
  type Phase,
} from "./dsl.ts";
export interface Row {
  readonly value: unknown;
  readonly version: number;
}
export type Write =
  | { readonly key: string; readonly value: unknown }
  | { readonly key: string; readonly delete: true };
export interface AtomicStore {
  get(key: string): Row | undefined | Promise<Row | undefined>;
  keys(prefix: string): readonly string[] | Promise<readonly string[]>;
  write(
    writes: readonly Write[],
    conditions?: readonly { key: string; version: number }[],
  ): boolean | Promise<boolean>;
  close(): void | Promise<void>;
}
export const RECORDS = port<AtomicStore>("records.atomic@1");
export const SESSIONS = port<AtomicStore>("agent.sessions@1");
export class SqliteRecords implements AtomicStore {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY,value TEXT NOT NULL,version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS revision(n INTEGER NOT NULL); INSERT INTO revision SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM revision);",
    );
  }
  get(key: string): Row | undefined {
    const row = this.db
      .query("SELECT value,version FROM records WHERE key=?")
      .get(key) as { value: string; version: number } | null;
    return row
      ? { value: JSON.parse(row.value) as unknown, version: row.version }
      : undefined;
  }
  keys(prefix: string): readonly string[] {
    return (
      this.db
        .query("SELECT key FROM records WHERE substr(key,1,?)=? ORDER BY key")
        .all(prefix.length, prefix) as { key: string }[]
    ).map((x) => x.key);
  }
  write(
    writes: readonly Write[],
    conditions: readonly { key: string; version: number }[] = [],
    afterWrite?: (index: number) => void,
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const condition of conditions)
        if ((this.get(condition.key)?.version ?? 0) !== condition.version) {
          this.db.exec("ROLLBACK");
          return false;
        }
      writes.forEach((w, i) => {
        if ("delete" in w)
          this.db.query("DELETE FROM records WHERE key=?").run(w.key);
        else {
          const encoded = JSON.stringify(w.value);
          if (encoded === undefined)
            throw new Fault("sqlite", "UNDEFINED_VALUE", w.key);
          this.db.exec("UPDATE revision SET n=n+1");
          const row = this.db.query("SELECT n FROM revision").get() as {
            n: number;
          };
          this.db
            .query(
              "INSERT INTO records VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=excluded.version",
            )
            .run(w.key, encoded, row.n);
        }
        afterWrite?.(i);
      });
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
export function sqlite(
  path: string,
  id = "routecraft.sqlite",
  replacement = false,
  contract = RECORDS,
) {
  return infrastructure({
    id,
    provides: [contract],
    replaces: replacement ? [contract] : [],
    bind(ctx) {
      const records = new SqliteRecords(path);
      ctx.onDispose(() => records.close());
      ctx.provide(contract, records);
    },
  });
}
/** What the `waiting/{id}` index carries, so a scan never reads a record it will not touch. */
interface WaitingIndex {
  readonly routeId: string;
  readonly expiresAt: number | null;
  readonly claimed: boolean;
}
/**
 * The deferral plugin's own record shape, private to it. Two keys per parked
 * exchange: `record/{id}` holds the continuation and its state, and
 * `waiting/{id}` is the index the sweep scans, carrying the due time, the
 * route and whether a claim holds, so a scan reads only what it may act on.
 * Both are written in one conditional transaction so a crash between them
 * cannot make a record invisible.
 */
export function durableStore(records: AtomicStore): ContinuationStore {
  const owner = "routecraft.deferral";
  const read = async (id: string) => {
    const row = await records.get(`record/${id}`);
    return row
      ? { row, saved: row.value as ContinuationRecord }
      : { row: undefined, saved: undefined };
  };
  const index = (saved: ContinuationRecord): WaitingIndex => ({
    routeId: saved.continuation.routeId,
    expiresAt: saved.continuation.expiresAt ?? null,
    claimed: saved.claimedAt !== undefined,
  });
  const settle = async (
    id: string,
    patch: Partial<ContinuationRecord>,
  ): Promise<"won" | "lost"> => {
    const { row, saved } = await read(id);
    if (!row || saved.state !== "waiting" || saved.claimedAt === undefined)
      return "lost";
    const won = await records.write(
      [
        { key: `record/${id}`, value: { ...saved, ...patch } },
        { key: `waiting/${id}`, delete: true },
      ],
      [{ key: `record/${id}`, version: row.version }],
    );
    return won ? "won" : "lost";
  };
  return {
    async create(id, continuation) {
      const value: ContinuationRecord = { state: "waiting", continuation };
      const won = await records.write(
        [
          { key: `record/${id}`, value },
          { key: `waiting/${id}`, value: index(value) },
        ],
        [{ key: `record/${id}`, version: 0 }],
      );
      if (!won) throw new Fault(owner, "DUPLICATE_DEFERRAL", id);
    },
    async get(id) {
      return (await read(id)).saved;
    },
    async markResumed(id, at, by) {
      const { row, saved } = await read(id);
      // A claimed record is being notified about; the claim excludes a resume until the lease releases it.
      if (!row || saved.state !== "waiting" || saved.claimedAt !== undefined)
        return "lost";
      const won = await records.write(
        [
          {
            key: `record/${id}`,
            value: {
              ...saved,
              state: "resumed",
              resumedAt: at,
              settledAt: at,
              ...(by !== undefined ? { by } : {}),
            },
          },
          { key: `waiting/${id}`, delete: true },
        ],
        [{ key: `record/${id}`, version: row.version }],
      );
      return won ? "won" : "lost";
    },
    async recordOutcome(id, outcome) {
      const { row, saved } = await read(id);
      if (!row) throw new Fault(owner, "MISSING_RECORD", id);
      // No compare: only the resume winner ever writes here.
      await records.write([
        { key: `record/${id}`, value: { ...saved, outcome } },
      ]);
    },
    async claimExpiry(id, at) {
      const { row, saved } = await read(id);
      if (!row || saved.state !== "waiting" || saved.claimedAt !== undefined)
        return "lost";
      const value = { ...saved, claimedAt: at };
      const won = await records.write(
        [
          { key: `record/${id}`, value },
          { key: `waiting/${id}`, value: index(value) },
        ],
        [{ key: `record/${id}`, version: row.version }],
      );
      return won ? "won" : "lost";
    },
    markExpired: (id, at) => settle(id, { state: "expired", settledAt: at }),
    markDenied: (id, at, reason) =>
      settle(id, { state: "denied", settledAt: at, reason }),
    async releaseClaims(before) {
      let released = 0;
      for (const key of await records.keys("waiting/")) {
        const id = key.slice("waiting/".length);
        const { row, saved } = await read(id);
        if (!row || saved.claimedAt === undefined || saved.claimedAt > before)
          continue;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit the claim
        const { claimedAt: _released, ...rest } = saved;
        if (
          await records.write(
            [
              { key: `record/${id}`, value: rest },
              { key: `waiting/${id}`, value: index(rest) },
            ],
            [{ key: `record/${id}`, version: row.version }],
          )
        )
          released++;
      }
      return released;
    },
    async findExpired(now, limit, after) {
      if (!Number.isInteger(limit) || limit < 1)
        throw new Fault(owner, "SCAN_LIMIT", String(limit));
      const due: ExpiredEntry[] = [];
      for (const key of await records.keys("waiting/")) {
        const entry = (await records.get(key))?.value as
          WaitingIndex | undefined;
        if (!entry || entry.claimed || entry.expiresAt === null) continue;
        if (entry.expiresAt > now) continue;
        const id = key.slice("waiting/".length);
        if (
          after &&
          (entry.expiresAt < after.expiresAt ||
            (entry.expiresAt === after.expiresAt && id <= after.id))
        )
          continue;
        due.push({ id, routeId: entry.routeId, expiresAt: entry.expiresAt });
      }
      return due
        .sort((a, b) => a.expiresAt - b.expiresAt || (a.id < b.id ? -1 : 1))
        .slice(0, limit);
    },
    async resumedWithoutOutcome(limit) {
      const stranded: string[] = [];
      for (const key of await records.keys("record/")) {
        const saved = (await records.get(key))?.value as
          ContinuationRecord | undefined;
        if (saved?.state === "resumed" && !saved.outcome)
          stranded.push(key.slice("record/".length));
      }
      return limit === undefined ? stranded : stranded.slice(0, limit);
    },
    async replaceStepState(id, expected, stepState) {
      const { row, saved } = await read(id);
      if (
        !row ||
        saved.state !== "waiting" ||
        saved.claimedAt !== undefined ||
        fingerprint(saved.continuation.stepState) !== expected
      )
        return "lost";
      const won = await records.write(
        [
          {
            key: `record/${id}`,
            value: {
              ...saved,
              continuation: { ...saved.continuation, stepState },
            },
          },
        ],
        [{ key: `record/${id}`, version: row.version }],
      );
      return won ? "won" : "lost";
    },
    async pending() {
      let count = 0,
        oldest: number | undefined;
      for (const key of await records.keys("waiting/")) {
        const saved = (
          await records.get(`record/${key.slice("waiting/".length)}`)
        )?.value as ContinuationRecord | undefined;
        if (!saved) continue;
        count++;
        if (oldest === undefined || saved.continuation.parkedAt < oldest)
          oldest = saved.continuation.parkedAt;
      }
      return oldest === undefined ? { count } : { count, oldest };
    },
    async purgeSettled(before) {
      let purged = 0;
      for (const key of await records.keys("record/")) {
        const saved = (await records.get(key))?.value as
          ContinuationRecord | undefined;
        if (
          !saved ||
          saved.state === "waiting" ||
          saved.settledAt === undefined ||
          saved.settledAt >= before
        )
          continue;
        if (await records.write([{ key, delete: true }])) purged++;
      }
      return purged;
    },
  };
}
type DeferralMethods<B, P extends readonly Plugin[], H extends object> = {
  defer(
    this: Cursor<B, P, H, "after">,
    name: string,
    ttl?: number,
  ): Chain<B, P, H, "after">;
};
interface DeferralFamily extends Family {
  readonly methods: DeferralMethods<
    this["Body"],
    this["Plugins"],
    this["Headers"]
  >;
}
export interface DeferralOptions {
  /** How long a parked exchange stays resumable when `.defer()` names no ttl. `null` opts a context out. */
  readonly ttl?: number | null;
  /** How long a notification claim is honoured before it is released for redelivery. */
  readonly lease?: number;
  /** How often the sweep runs. `0` disables the timer; the boot scan still runs. */
  readonly interval?: number;
  /** How long settled records are kept, measured from settlement. Absent: kept forever. */
  readonly retention?: number;
}
type DeferralFacets = {
  readonly deferral: (ex: Exchange) => {
    readonly id: string;
    request(
      name: string,
      ttl?: number,
    ): {
      kind: "defer";
      exchange: Exchange;
      request: { name: string; reason: string; ttl?: number };
    };
  };
};
export const DEFAULT_TTL = 72 * 60 * 60 * 1000;
export const DEFAULT_LEASE = 60 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL = 60 * 1000;
export const DEFAULT_RETENTION = 90 * 24 * 60 * 60 * 1000;
/**
 * Provides the continuation store over the atomic records port and owns
 * expiry policy: the lease, the sweep cadence and retention. Its start hook
 * is the boot scan the shipped sweeper runs: heal, purge, retire what came
 * due while the process was down, and report the residue of a process that
 * died mid-continuation, before the timer is armed.
 */
export function deferralPlugin(
  options: DeferralOptions = {},
): Plugin<DeferralFamily, DeferralFacets> {
  const lease = options.lease ?? DEFAULT_LEASE,
    interval = options.interval ?? DEFAULT_SWEEP_INTERVAL,
    retention = options.retention ?? DEFAULT_RETENTION,
    ttl = options.ttl === undefined ? DEFAULT_TTL : options.ttl;
  let timer: ReturnType<typeof setInterval> | undefined;
  const facets = {
    deferral: (ex: Exchange) => ({
      /** The id the NEXT defer on this exchange will park under, so a step can embed it before parking. */
      id: `${ex.id}#${(Number(ex.headers[DEFERRAL_SEQUENCE]) || 0) + 1}`,
      request: (name: string, given?: number) => ({
        kind: "defer" as const,
        exchange: ex,
        request: {
          name,
          reason: "approval",
          ...(given !== undefined ? { ttl: given } : {}),
        },
      }),
    }),
  };
  return {
    id: "routecraft.deferral",
    // Requires what it provides, so a boot report reads the SELECTED store, a vendor's included.
    requires: [RECORDS, CONTINUATIONS],
    provides: [CONTINUATIONS],
    facets,
    methods<B, P extends readonly Plugin[], H extends object, S extends Phase>(
      cursor: Cursor<B, P, H, S>,
    ) {
      return {
        defer: (name: string, given?: number) =>
          cursor.step(`defer:${name}`, (ex) => ({
            kind: "defer",
            exchange: ex,
            request: {
              name,
              reason: "approval",
              ...(given !== undefined ? { ttl: given } : {}),
            },
          })),
      };
    },
    bind(ctx: PluginContext) {
      // The default deadline travels with the store, so the kernel applies it to every park, however raised.
      ctx.provide(CONTINUATIONS, {
        ...durableStore(ctx.require(RECORDS)),
        defaults: ttl !== null ? { ttl } : {},
      });
      ctx.onDispose(() => {
        if (timer) clearInterval(timer);
        timer = undefined;
      });
    },
    async start(ctx: PluginContext) {
      const store = ctx.require(CONTINUATIONS);
      const sweep = () => ctx.execution.sweep({ lease, retention });
      const report = await sweep();
      const stranded = await store.resumedWithoutOutcome(100);
      ctx.emit("boot", { ...report, stranded, pending: await store.pending() });
      if (interval > 0) {
        timer = setInterval(() => {
          void sweep().catch((e) => ctx.emit("sweep:failed", String(e)));
        }, interval);
        timer.unref();
      }
    },
  };
}
export const deferral = deferralPlugin();
