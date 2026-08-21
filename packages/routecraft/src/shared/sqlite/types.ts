/**
 * The minimal synchronous SQLite surface the framework's storage
 * subsystems need, declared once for every consumer.
 *
 * Declared here rather than imported so neither `bun-types` nor
 * `@types/better-sqlite3` reaches the published type surface. `bun:sqlite`
 * and `better-sqlite3` both satisfy this shape, which is what lets one
 * store implementation sit on either driver.
 *
 * A consumer needing more than this extends {@link SqliteDatabase} with
 * the members it actually uses, rather than re-deriving what the two
 * drivers have in common.
 */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/**
 * Constructor shape shared by both drivers. The options argument is
 * optional because `bun:sqlite` and `better-sqlite3` accept one and the
 * suspension store passes none; typing it here keeps callers that do pass
 * options from re-declaring the whole constructor.
 */
export type SqliteDatabaseConstructor = new (
  filename: string,
  options?: { readonly?: boolean; create?: boolean },
) => SqliteDatabase;
