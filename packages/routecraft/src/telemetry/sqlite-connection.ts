import { mkdirSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { ALL_DDL } from "./schema.ts";

/**
 * Default path for the telemetry database, relative to cwd.
 */
const DEFAULT_DB_PATH = ".routecraft/telemetry.db";

/**
 * Shared SQLite connection for telemetry.
 *
 * Encapsulates database opening, WAL mode, and DDL execution.
 * Used by both {@link SqliteSpanProcessor} and {@link SqliteEventWriter}.
 */
export class SqliteConnection {
  readonly db: BetterSqlite3Database;

  private constructor(db: BetterSqlite3Database) {
    this.db = db;
  }

  /**
   * Open (or create) the telemetry database.
   *
   * @returns A connection, or `null` if `better-sqlite3` is not installed.
   */
  static async open(options?: {
    dbPath?: string;
    walMode?: boolean;
  }): Promise<SqliteConnection | null> {
    const dbPathRaw = options?.dbPath ?? DEFAULT_DB_PATH;
    const dbPath = isAbsolute(dbPathRaw)
      ? dbPathRaw
      : resolve(process.cwd(), dbPathRaw);
    const walMode = options?.walMode !== false;

    let Database: BetterSqlite3Constructor;
    try {
      const mod = await import("better-sqlite3");
      Database = (mod.default ?? mod) as BetterSqlite3Constructor;
    } catch {
      return null;
    }

    try {
      mkdirSync(dirname(dbPath), { recursive: true });

      const db = new Database(dbPath);

      if (walMode) {
        db.pragma("journal_mode = WAL");
      }

      for (const ddl of ALL_DDL) {
        db.exec(ddl);
      }

      return new SqliteConnection(db);
    } catch {
      return null;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore close errors during teardown
    }
  }
}

// Minimal type definitions for better-sqlite3 to avoid requiring
// @types/better-sqlite3 as a production dependency.

type BetterSqlite3Database = {
  pragma(pragma: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): BetterSqlite3Statement;
  transaction<T>(fn: (...args: T[]) => void): (...args: T[]) => void;
  close(): void;
};

type BetterSqlite3Statement = {
  run(...params: unknown[]): unknown;
};

type BetterSqlite3Constructor = new (filename: string) => BetterSqlite3Database;

export type { BetterSqlite3Database, BetterSqlite3Statement };
