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

/** What went wrong in {@link migrateSqlite}, for the consumer's own error. */
export interface SqliteMigrationFailure {
  /**
   * `downgrade` is a file written by a newer build, which no migration can
   * repair; `migrate` is a statement that failed.
   */
  readonly kind: "downgrade" | "migrate";
  readonly cause: unknown;
  /** The version the file is on. */
  readonly current: number;
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
 * @param options.schemaVersion - The version this build understands.
 * @param options.migrations - Forward-only statements; index `n` migrates
 *   version `n` to `n + 1`, so a fresh file runs them all.
 * @param options.onFailure - Builds the store's own error for a failure.
 *   The returned error is thrown as it is, so each store keeps its code.
 */
export function migrateSqlite(
  db: SqliteDatabase,
  options: {
    schemaVersion: number;
    migrations: ReadonlyArray<string>;
    onFailure: (failure: SqliteMigrationFailure) => Error;
  },
): void {
  const { schemaVersion, migrations, onFailure } = options;
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
    // The downgrade guard has to run BEFORE the up-to-date check, not
    // after: a file written by a newer build satisfies both conditions, so
    // ordering it second made it unreachable and turned a rollback into a
    // misleading write failure on first use.
    if (current > schemaVersion) {
      refusal = onFailure({ kind: "downgrade", cause: undefined, current });
      throw refusal;
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
    throw onFailure({ kind: "migrate", cause, current });
  }
}
