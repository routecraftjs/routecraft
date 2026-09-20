import { Database } from "bun:sqlite";
import {
  port,
  CONTINUATIONS,
  type Continuation,
  type ContinuationStore,
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
interface Saved {
  readonly state: "waiting" | "running" | "completed" | "failed";
  readonly continuation: Continuation;
}
export function durableStore(records: AtomicStore): ContinuationStore {
  return {
    async save(id, continuation) {
      const won = await records.write(
        [
          { key: `record/${id}`, value: { state: "waiting", continuation } },
          { key: `waiting/${id}`, value: null },
        ],
        [{ key: `record/${id}`, version: 0 }],
      );
      if (!won)
        throw new Fault("routecraft.deferral", "DUPLICATE_DEFERRAL", id);
    },
    async read(id) {
      const row = await records.get(`record/${id}`);
      return row ? (row.value as Saved).continuation : undefined;
    },
    async claim(id) {
      const row = await records.get(`record/${id}`);
      if (!row || (row.value as Saved).state !== "waiting") return undefined;
      const saved = row.value as Saved;
      const won = await records.write(
        [
          { key: `record/${id}`, value: { ...saved, state: "running" } },
          { key: `waiting/${id}`, delete: true },
        ],
        [{ key: `record/${id}`, version: row.version }],
      );
      return won ? saved.continuation : undefined;
    },
    async finish(id, state) {
      const row = await records.get(`record/${id}`);
      if (!row) throw new Fault("routecraft.deferral", "MISSING_RECORD", id);
      const won = await records.write(
        [{ key: `record/${id}`, value: { ...(row.value as Saved), state } }],
        [{ key: `record/${id}`, version: row.version }],
      );
      if (!won) throw new Fault("routecraft.deferral", "FINISH_CONFLICT", id);
    },
  };
}
type DeferralMethods<B, P extends readonly Plugin[], H extends object> = {
  defer(this: Cursor<B, P, H, "after">, id: string): Chain<B, P, H, "after">;
};
interface DeferralFamily extends Family {
  readonly methods: DeferralMethods<
    this["Body"],
    this["Plugins"],
    this["Headers"]
  >;
}
const facets = {
  deferral: (ex: import("./contracts.ts").Exchange) => ({
    request: (id: string) => ({
      kind: "defer" as const,
      exchange: ex,
      request: { id, reason: "approval" },
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
      defer: (id: string) =>
        cursor.step(`defer:${id}`, (ex) => facets.deferral(ex).request(id)),
    };
  },
  bind(ctx: PluginContext) {
    ctx.provide(CONTINUATIONS, durableStore(ctx.require(RECORDS)));
  },
};
