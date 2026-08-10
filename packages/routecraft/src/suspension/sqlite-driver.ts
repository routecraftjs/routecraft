import { loadOptionalPeer } from "../adapters/shared/optional-peer.ts";

/**
 * The minimal synchronous SQLite surface the suspension store needs.
 *
 * Declared here rather than imported so neither `bun-types` nor
 * `@types/better-sqlite3` reaches the published type surface. `bun:sqlite`
 * and `better-sqlite3` both satisfy this shape, which is what lets one
 * store implementation sit on either driver.
 */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export type SqliteDatabaseConstructor = new (
  filename: string,
) => SqliteDatabase;

/**
 * Which driver backs a resolved connection. Surfaced so the store factory
 * can log what a deployment actually got, and so tests can assert the split
 * rather than infer it.
 */
export type SqliteDriverName = "bun:sqlite" | "better-sqlite3";

export interface ResolvedSqliteDriver {
  readonly name: SqliteDriverName;
  readonly Database: SqliteDatabaseConstructor;
}

/**
 * Resolve a synchronous SQLite driver for the current runtime.
 *
 * ## The decision (#549, 2026-08-10)
 *
 * Candidate 1 of three, the per-runtime split: `bun:sqlite` under Bun,
 * `better-sqlite3` as an optional peer under Node, in-memory fallback with
 * a loud warning when neither is available. Chosen because the feature's
 * whole promise is surviving a restart, so the default must be durable
 * wherever the runtime allows rather than durable only where someone opted
 * in.
 *
 * ## The version matrix it was decided against
 *
 * The obvious answer, `node:sqlite`, is ruled out by the engines floor
 * rather than by its API:
 *
 * | Runtime | `bun:sqlite` | `node:sqlite` | `better-sqlite3` |
 * | --- | --- | --- | --- |
 * | Bun >= 1.1 (our floor) | built in | n/a | installable |
 * | Node 22.0 - 22.4 (our floor) | n/a | does not exist | installable |
 * | Node 22.5+ | n/a | behind `--experimental-sqlite` | installable |
 * | Node 24+ | n/a | unflagged | installable |
 *
 * Core's floor is Node 22.0, so across the supported range `node:sqlite`
 * either does not exist or needs a CLI flag the framework cannot set on the
 * user's behalf. That inverts the naive preference order for the Node arm
 * and leaves `better-sqlite3` as the only Node option that works on the
 * whole range.
 *
 * ## Graduation condition for `node:sqlite`
 *
 * `node:sqlite` becomes the preferred Node driver, ahead of
 * `better-sqlite3`, once `@routecraft/routecraft`'s `engines.node` floor
 * moves past the first Node major where it runs unflagged (Node 24). At
 * that point it is a built-in with no install step and no native rebuild,
 * which beats an optional peer on every axis; `better-sqlite3` stays
 * supported as a fallback for anyone below the new floor. Revisit this
 * function and nothing else: the store talks to {@link SqliteDatabase},
 * not to a driver.
 *
 * @param loaders - Injection point for tests, which need to simulate a
 *   runtime that lacks a driver without leaving the runtime they run on.
 * @returns The resolved driver for this runtime.
 * @throws RC5017 when running under Node and `better-sqlite3` is absent.
 *   Whether that is fatal is the store factory's call, not this
 *   function's: an unconfigured context falls back to memory with a
 *   warning, while a context that named a store path fails to start,
 *   because silently degrading a deployment that asked for durability is
 *   worse than refusing to run.
 */
export async function resolveSqliteDriver(
  loaders: SqliteDriverLoaders = defaultLoaders,
): Promise<ResolvedSqliteDriver> {
  if (isBun()) {
    return { name: "bun:sqlite", Database: await loaders.bun() };
  }
  return { name: "better-sqlite3", Database: await loaders.node() };
}

/**
 * Driver loaders, injectable so a test can exercise the absent-peer arm
 * without uninstalling anything.
 *
 * @internal
 */
export interface SqliteDriverLoaders {
  bun(): Promise<SqliteDatabaseConstructor>;
  node(): Promise<SqliteDatabaseConstructor>;
}

/** @internal */
export const defaultLoaders: SqliteDriverLoaders = {
  async bun() {
    // A Bun built-in, not an optional peer: there is no package to install
    // and no RC5017 to raise, so this is deliberately outside
    // `loadOptionalPeer`. Under Bun the import always resolves.
    const mod = await import("bun:sqlite");
    return (mod as { Database: unknown }).Database as SqliteDatabaseConstructor;
  },
  async node() {
    const mod = await loadOptionalPeer(() => import("better-sqlite3"), {
      adapterName: "suspension store (sqlite)",
      packageName: "better-sqlite3",
    });
    const ctor = (mod as { default?: unknown }).default ?? mod;
    return ctor as SqliteDatabaseConstructor;
  },
};

/** @internal */
export function isBun(): boolean {
  return typeof process.versions["bun"] === "string";
}
