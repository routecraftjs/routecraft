import { Database } from "bun:sqlite";
import {
  port,
  CONTINUATIONS,
  DEFERRAL_SEQUENCE,
  type ContinuationRecord,
  type ContinuationStore,
  type Exchange,
  type PluginContext,
  Fault,
} from "./contracts.ts";
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
/**
 * The deferral plugin's own record shape, private to it. Two keys per parked
 * exchange: `record/{id}` holds the continuation and its state, and
 * `waiting/{id}` is the index the sweep scans, carrying the due time so a
 * scan does not read every record. Both are written in one conditional
 * transaction so a crash between them cannot make a record invisible.
 */
export function durableStore(records: AtomicStore): ContinuationStore {
  const owner = "routecraft.deferral";
  const read = async (id: string) => {
    const row = await records.get(`record/${id}`);
    return row
      ? { row, saved: row.value as ContinuationRecord }
      : { row: undefined, saved: undefined };
  };
  return {
    async create(id, continuation) {
      const won = await records.write(
        [
          {
            key: `record/${id}`,
            value: { state: "waiting", continuation } as ContinuationRecord,
          },
          { key: `waiting/${id}`, value: continuation.expiresAt ?? null },
        ],
        [{ key: `record/${id}`, version: 0 }],
      );
      if (!won) throw new Fault(owner, "DUPLICATE_DEFERRAL", id);
    },
    async get(id) {
      return (await read(id)).saved;
    },
    async markResumed(id, at) {
      const { row, saved } = await read(id);
      if (!row || saved.state !== "waiting") return "lost";
      const won = await records.write(
        [
          {
            key: `record/${id}`,
            value: { ...saved, state: "resumed", resumedAt: at },
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
      const won = await records.write(
        [{ key: `record/${id}`, value: { ...saved, claimedAt: at } }],
        [{ key: `record/${id}`, version: row.version }],
      );
      return won ? "won" : "lost";
    },
    async markExpired(id) {
      const { row, saved } = await read(id);
      if (!row || saved.state !== "waiting" || saved.claimedAt === undefined)
        return "lost";
      const won = await records.write(
        [
          { key: `record/${id}`, value: { ...saved, state: "expired" } },
          { key: `waiting/${id}`, delete: true },
        ],
        [{ key: `record/${id}`, version: row.version }],
      );
      return won ? "won" : "lost";
    },
    async releaseClaims(before) {
      let released = 0;
      for (const key of await records.keys("waiting/")) {
        const { row, saved } = await read(key.slice("waiting/".length));
        if (!row || saved.claimedAt === undefined || saved.claimedAt > before)
          continue;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit the claim
        const { claimedAt: _released, ...rest } = saved;
        if (
          await records.write(
            [{ key: `record/${key.slice("waiting/".length)}`, value: rest }],
            [
              {
                key: `record/${key.slice("waiting/".length)}`,
                version: row.version,
              },
            ],
          )
        )
          released++;
      }
      return released;
    },
    async findExpired(now, limit = 100) {
      const due: { id: string; at: number }[] = [];
      for (const key of await records.keys("waiting/")) {
        const at = (await records.get(key))?.value;
        if (typeof at === "number" && at <= now)
          due.push({ id: key.slice("waiting/".length), at });
      }
      return due
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((d) => d.id);
    },
    async resumedWithoutOutcome() {
      const stranded: string[] = [];
      for (const key of await records.keys("record/")) {
        const saved = (await records.get(key))?.value as
          ContinuationRecord | undefined;
        if (saved?.state === "resumed" && !saved.outcome)
          stranded.push(key.slice("record/".length));
      }
      return stranded;
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
const facets = {
  deferral: (ex: Exchange) => ({
    /** The id the NEXT defer on this exchange will park under, so a step can embed it before parking. */
    id: `${ex.id}#${(Number(ex.headers[DEFERRAL_SEQUENCE]) || 0) + 1}`,
    request: (name: string, ttl?: number) => ({
      kind: "defer" as const,
      exchange: ex,
      request: {
        name,
        reason: "approval",
        ...(ttl !== undefined ? { ttl } : {}),
      },
    }),
  }),
};
export const deferral: Plugin<DeferralFamily, typeof facets> = {
  id: "routecraft.deferral",
  requires: [RECORDS],
  provides: [CONTINUATIONS],
  facets,
  methods<B, P extends readonly Plugin[], H extends object, S extends Phase>(
    cursor: Cursor<B, P, H, S>,
  ) {
    return {
      defer: (name: string, ttl?: number) =>
        cursor.step(`defer:${name}`, (ex) => ({
          kind: "defer",
          exchange: ex,
          request: {
            name,
            reason: "approval",
            ...(ttl !== undefined ? { ttl } : {}),
          },
        })),
    };
  },
  bind(ctx: PluginContext) {
    ctx.provide(CONTINUATIONS, durableStore(ctx.require(RECORDS)));
  },
};
