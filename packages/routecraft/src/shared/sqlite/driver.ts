/// <reference types="bun-types" />
import { createRequire } from "node:module";
import { loadOptionalPeer } from "../../adapters/shared/optional-peer.ts";
import { rcError } from "../../error.ts";
import type { SqliteDatabaseConstructor } from "./types.ts";

export type {
  SqliteDatabase,
  SqliteDatabaseConstructor,
  SqliteStatement,
} from "./types.ts";

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
 * `bun:sqlite` under Bun, `better-sqlite3` as an optional peer under Node,
 * and an in-memory fallback with a loud warning when neither is available.
 * The default is durable wherever the runtime allows, because surviving a
 * restart is the feature's whole promise.
 *
 * ## Why not `node:sqlite`
 *
 * It is ruled out by the engines floor rather than by its API:
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
 * @param consumer - Names the subsystem asking, so an absent peer names
 *   what wanted it ("deferral store (sqlite)", "telemetry (sqlite)")
 *   rather than reporting a generic sqlite failure. Used ONLY to build the
 *   default loaders: a caller that supplies its own `loaders` owns the
 *   naming inside them, and this argument then has no effect.
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
  consumer: string,
  loaders: SqliteDriverLoaders = defaultLoaders(consumer),
): Promise<ResolvedSqliteDriver> {
  if (isBun()) {
    return { name: "bun:sqlite", Database: await loaders.bun() };
  }
  return { name: "better-sqlite3", Database: await loaders.node() };
}

/**
 * Driver loaders. Injectable so a store in another package, or a test
 * exercising the absent-peer arm, supplies its own resolution rather than
 * the runtime's.
 */
export interface SqliteDriverLoaders {
  bun(): Promise<SqliteDatabaseConstructor>;
  node(): Promise<SqliteDatabaseConstructor>;
}

/**
 * The real loaders for a named consumer. A factory rather than a constant
 * because the Node arm's RC5017 has to name who wanted the driver.
 *
 * @internal
 */
export function defaultLoaders(consumer: string): SqliteDriverLoaders {
  return {
    async bun() {
      // A Bun built-in, not an optional peer: there is no package to install
      // and no RC5017 to raise, so this is deliberately outside
      // `loadOptionalPeer`. Under Bun the import always resolves.
      const mod = await import("bun:sqlite");
      return (mod as { Database: unknown })
        .Database as SqliteDatabaseConstructor;
    },
    async node() {
      const mod = await loadOptionalPeer(() => import("better-sqlite3"), {
        consumer,
        packageName: "better-sqlite3",
      });
      assertBetterSqliteRuns(
        consumer,
        installedBetterSqliteVersion(),
        process.versions["napi"],
      );
      const ctor = (mod as { default?: unknown }).default ?? mod;
      return ctor as SqliteDatabaseConstructor;
    },
  };
}

/**
 * Refuse a `better-sqlite3` the running Node cannot load.
 *
 * From 13 its binaries target Node-API 10, which Node ships from 22.14.
 * Core's floor is Node 22.0, and below 22.14 constructing a database does
 * not throw: the addon segfaults the process past every catch. The pairing
 * is therefore refused before the first database opens, with the same
 * RC5017 a missing driver raises, so the stores fall back or fail at start
 * exactly as they do without the peer.
 *
 * @param consumer - The subsystem asking, named in the error.
 * @param version - The installed `better-sqlite3` version.
 * @param nodeApi - The runtime's Node-API version (`process.versions.napi`).
 * @throws RC5017 when `better-sqlite3` is 13 or later and Node-API is below 10.
 * @internal
 */
export function assertBetterSqliteRuns(
  consumer: string,
  version: string,
  nodeApi: string | undefined,
): void {
  const major = Number.parseInt(version, 10);
  if (major < 13 || Number(nodeApi ?? 0) >= 10) return;
  throw rcError("RC5017", undefined, {
    message:
      `${consumer} cannot use better-sqlite3 ${version} on Node ${process.versions.node}: ` +
      "it needs Node 22.14 or later. Upgrade Node, or install better-sqlite3 12: " +
      "bun add better-sqlite3@12 (or npm install better-sqlite3@12).",
  });
}

function installedBetterSqliteVersion(): string {
  const require = createRequire(import.meta.url);
  return (require("better-sqlite3/package.json") as { version: string })
    .version;
}

/** @internal */
export function isBun(): boolean {
  return typeof process.versions["bun"] === "string";
}
