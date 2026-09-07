import { isAbsolute, resolve } from "node:path";
import type { SqliteDatabase } from "./types.ts";

/**
 * A database file path as the drivers want it: absolute, or the
 * `":memory:"` sentinel untouched.
 *
 * Shared because a store that resolves the path differently in two places
 * (an existence probe and the open beside it) reports an empty store while
 * a database sits on disk holding its records.
 */
export function resolveDatabasePath(path: string): string {
  if (path === ":memory:") return path;
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/**
 * Whether a driver error is SQLite reporting lock contention rather than a
 * permanent fault. Both drivers surface it in the message; better-sqlite3
 * additionally sets a `code`.
 *
 * Shared because this is knowledge about the drivers rather than about any
 * one store, and a store that answers a transient lock as a permanent
 * failure sends its caller to the wrong remedy.
 */
export function isSqliteBusy(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^SQLITE_BUSY|^SQLITE_LOCKED/.test(code)) {
    return true;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(
    message,
  );
}

/**
 * Which store a database file belongs to, stamped into
 * `PRAGMA application_id` so a store can tell its own file from another's.
 *
 * Every store in the repository writes into `.routecraft/` and versions
 * itself through `PRAGMA user_version`, which is one integer per file. Two
 * stores pointed at one path therefore cannot both be satisfied, and
 * without an identity the loser can only report the version it found,
 * which reads as "upgrade your build" for a file no build will ever
 * understand.
 *
 * The values are the ASCII of a four-letter tag, which is what
 * `application_id` is conventionally used for and what `file` and
 * `sqlite3` will show an operator.
 */
export const SQLITE_APPLICATION_IDS = {
  /** "RCSU", the suspension store. */
  suspension: 0x5243_5355,
  /** "RCSE", the agent session store. */
  session: 0x5243_5345,
} as const;

/** A stamped identity, or 0 for a file no build has claimed. */
export type SqliteApplicationId =
  (typeof SQLITE_APPLICATION_IDS)[keyof typeof SQLITE_APPLICATION_IDS] | 0;

/** The tag a stamped file carries, for naming it in a refusal. */
export function sqliteApplicationName(id: number): string | undefined {
  for (const [name, value] of Object.entries(SQLITE_APPLICATION_IDS)) {
    if (value === id) return name;
  }
  return undefined;
}

/** What went wrong in {@link migrateSqlite}, for the consumer's own error. */
export interface SqliteMigrationFailure {
  /**
   * `foreign` is a file belonging to a different store, which is a
   * configuration mistake rather than a version problem; `downgrade` is a
   * file written by a newer build of THIS store, which no migration can
   * repair; `migrate` is a statement that failed.
   */
  readonly kind: "foreign" | "downgrade" | "migrate";
  readonly cause: unknown;
  /** The version the file is on. */
  readonly current: number;
  /**
   * The file's own tables, so a refusal can say what the file actually is
   * rather than only what it is not. Empty for a file with no schema.
   */
  readonly tables: readonly string[];
  /**
   * The identity stamped on the file: another store's id, or 0 when the
   * file predates stamping and was identified by its tables instead.
   */
  readonly applicationId: number;
}

/**
 * Bring a database's schema up to date from `PRAGMA user_version`, inside
 * one transaction so an interrupted upgrade leaves the file on its previous
 * version rather than half way between two.
 *
 * The version is read INSIDE the write transaction. Two processes starting
 * against one file would otherwise both read version 0, both try to create
 * the tables, and the loser fail on an existing table, which for a store
 * that falls back to memory means losing durability at exactly the moment
 * a deployment restarts.
 *
 * Before any of that, the file is checked to be this store's own. A store
 * adopts a file only when the file is empty, or already carries this
 * store's identity, or predates stamping and holds this store's own table.
 * Anything else is refused as `foreign`, because two stores sharing one
 * path is a configuration mistake that no migration can resolve.
 *
 * @param options.schemaVersion - The version this build understands.
 * @param options.migrations - Forward-only statements; index `n` migrates
 *   version `n` to `n + 1`, so a fresh file runs them all.
 * @param options.applicationId - This store's identity, stamped into
 *   `PRAGMA application_id` on adoption.
 * @param options.identityTable - A table this store's schema always has,
 *   used to adopt files written before stamping existed.
 * @param options.onFailure - Builds the store's own error for a failure.
 *   The returned error is thrown as it is, so each store keeps its code.
 */
export function migrateSqlite(
  db: SqliteDatabase,
  options: {
    schemaVersion: number;
    migrations: ReadonlyArray<string>;
    applicationId: SqliteApplicationId;
    identityTable: string;
    onFailure: (failure: SqliteMigrationFailure) => Error;
  },
): void {
  const { schemaVersion, migrations, applicationId, identityTable, onFailure } =
    options;
  let current = 0;
  // The downgrade error is built inside the transaction and rethrown
  // unwrapped by the catch below, which cannot otherwise tell it from a
  // statement that failed.
  let refusal: Error | undefined;
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("PRAGMA user_version").get() as
      { user_version?: number } | undefined;
    current = row?.user_version ?? 0;
    const tables = tablesIn(db);
    const empty = schemaIsEmpty(db);
    const stamped =
      (
        db.prepare("PRAGMA application_id").get() as
          { application_id?: number } | undefined
      )?.application_id ?? 0;
    // Ownership is settled before the version is looked at. A file
    // belonging to another store is on ITS version line, so reporting that
    // number as a downgrade tells the reader to find a newer build of a
    // store that will never open this file.
    if (stamped !== 0 && stamped !== applicationId) {
      refusal = onFailure({
        kind: "foreign",
        cause: undefined,
        current,
        tables,
        applicationId: stamped,
      });
      throw refusal;
    }
    // An unstamped file predates stamping, so its schema is the only
    // evidence. A file with none at all is ours to claim; one already
    // carrying our table is ours to adopt; anything else is not.
    //
    // Emptiness is decided over every schema object rather than over
    // tables, because a file holding only views, indexes or triggers has no
    // tables and still belongs to somebody. The table subset stays the
    // evidence for ownership, since identityTable is a table.
    if (stamped === 0 && !empty && !tables.includes(identityTable)) {
      refusal = onFailure({
        kind: "foreign",
        cause: undefined,
        current,
        tables,
        applicationId: 0,
      });
      throw refusal;
    }
    // The downgrade guard has to run BEFORE the up-to-date check, not
    // after: a file written by a newer build satisfies both conditions, so
    // ordering it second made it unreachable and turned a rollback into a
    // misleading write failure on first use.
    if (current > schemaVersion) {
      refusal = onFailure({
        kind: "downgrade",
        cause: undefined,
        current,
        tables,
        applicationId: stamped,
      });
      throw refusal;
    }
    if (stamped !== applicationId) {
      // Interpolated rather than bound: PRAGMA takes no parameters. The
      // value is a module constant, never user input.
      db.exec(`PRAGMA application_id = ${applicationId}`);
    }
    if (current === schemaVersion) {
      db.exec("COMMIT");
      return;
    }
    for (let version = current; version < schemaVersion; version++) {
      db.exec(migrations[version] as string);
    }
    // Interpolated rather than bound: PRAGMA does not accept parameters.
    // The value is the caller's module constant, never user input.
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
    db.exec("COMMIT");
  } catch (cause) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // BEGIN itself failed; there is no transaction to roll back.
    }
    if (refusal !== undefined && cause === refusal) throw refusal;
    throw onFailure({
      kind: "migrate",
      cause,
      current,
      tables: [],
      applicationId: 0,
    });
  }
}

/**
 * Whether the file carries no schema of its own, which is what makes it
 * safe to claim. Counted over every object type, so a file holding only a
 * view, an index or a trigger is not mistaken for an unused one.
 */
function schemaIsEmpty(db: SqliteDatabase): boolean {
  const row = db
    .prepare(
      "SELECT count(*) AS objects FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    )
    .get() as { objects: number };
  return row.objects === 0;
}

/**
 * The file's own table names, the evidence for ownership and for naming
 * what a foreign file actually holds.
 */
function tablesIn(db: SqliteDatabase): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * Say what a foreign file actually is, for the refusal that names it.
 *
 * A stamped file names itself. One that predates stamping is described by
 * its tables, which is the only evidence there is, and is worth printing
 * because it is what an operator sees running `sqlite3` against the file.
 */
export function describeSqliteFile(failure: SqliteMigrationFailure): string {
  const name = sqliteApplicationName(failure.applicationId);
  if (name !== undefined) return `it belongs to the ${name} store`;
  if (failure.tables.length === 0) return "it holds an unrecognised schema";
  return `it holds ${failure.tables.join(", ")}`;
}
