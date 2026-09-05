import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  rcError,
  resolveSqliteDriver,
  type ResolvedSqliteDriver,
  type SqliteDatabase,
  type SqliteDriverLoaders,
} from "@routecraft/routecraft";
import type { AgentSessionKey } from "./types.ts";
import type { SessionCasResult, SessionStore, StoredSession } from "./port.ts";
// Registers AI1012, thrown from the store failures below.
import "../../errors.ts";

/**
 * Default location of the session database, relative to the working
 * directory and beside the suspension database. A container deployment
 * points it at a mounted volume through `sessions: { store: { path } }` or
 * `ROUTECRAFT_SESSION_STORE`.
 */
export const DEFAULT_SESSION_DB_PATH = ".routecraft/sessions.db";

/** Names this subsystem in the absent-peer error under Node. */
export const SESSION_SQLITE_CONSUMER = "agent session store (sqlite)";

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Forward-only migrations from `PRAGMA user_version`; index `n` migrates
 * version `n` to `n + 1`, so a fresh file runs them all and an up-to-date
 * one runs none. Opening the store is the migrate step.
 */
const MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE agent_sessions (
     agent      TEXT    NOT NULL,
     session    TEXT    NOT NULL,
     version    INTEGER NOT NULL,
     record     TEXT    NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (agent, session)
   );`,
];

/**
 * Durable session store on SQLite: `bun:sqlite` under Bun and
 * `better-sqlite3` under Node, one implementation over both. The drivers
 * are synchronous, which is what makes the compare-and-swap atomic here: a
 * single `UPDATE ... WHERE version = ?` changes one row or none, and the
 * driver says which.
 *
 * Open it with {@link SqliteSessionStore.open}; the constructor is private
 * because a store is only usable once its schema has been migrated.
 */
export class SqliteSessionStore implements SessionStore {
  readonly #db: SqliteDatabase;

  /** Which driver backs this store, for the startup log line and tests. */
  readonly driver: ResolvedSqliteDriver["name"];

  #closed = false;

  private constructor(
    db: SqliteDatabase,
    driver: ResolvedSqliteDriver["name"],
  ) {
    this.#db = db;
    this.driver = driver;
  }

  /**
   * Open (creating if absent) the session database and bring its schema
   * up to date.
   *
   * @param options.path - Database file, absolute or relative to the
   *   working directory. `":memory:"` opens a private in-process database
   *   for exercising the sqlite paths in tests without touching disk.
   * @param options.loaders - Driver loader injection point for tests.
   * @throws RC5017 under Node when `better-sqlite3` is not installed.
   * @throws AI1012 when the file cannot be opened or migrated.
   */
  static async open(options: {
    path: string;
    loaders?: SqliteDriverLoaders;
  }): Promise<SqliteSessionStore> {
    const driver = await resolveSqliteDriver(
      SESSION_SQLITE_CONSUMER,
      options.loaders,
    );
    const path =
      options.path === ":memory:"
        ? options.path
        : isAbsolute(options.path)
          ? options.path
          : resolve(process.cwd(), options.path);
    let db: SqliteDatabase;
    try {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      db = new driver.Database(path);
    } catch (cause) {
      throw rcError("AI1012", cause, {
        message: `The agent session store at "${path}" could not be opened.`,
      });
    }
    try {
      initialise(db);
    } catch (cause) {
      // The handle exists but no store owns it yet, so nothing else would
      // ever close it; release it before the error propagates.
      try {
        db.close();
      } catch {
        // Already unusable; the original cause is what matters.
      }
      throw rcError("AI1012", cause, {
        message: `The agent session store at "${path}" could not be migrated to schema version ${SCHEMA_VERSION}.`,
      });
    }
    return new SqliteSessionStore(db, driver.name);
  }

  async get(key: AgentSessionKey): Promise<StoredSession | undefined> {
    const row = this.guard("read", () =>
      this.#db
        .prepare(
          "SELECT version, record FROM agent_sessions WHERE agent = ? AND session = ?",
        )
        .get(key.agent, key.session),
    ) as { version: number; record: string } | undefined | null;
    if (!row) return undefined;
    return { value: JSON.parse(row.record) as unknown, version: row.version };
  }

  async create(
    key: AgentSessionKey,
    value: unknown,
  ): Promise<SessionCasResult> {
    const record = JSON.stringify(value);
    return this.guard("write", () => {
      try {
        this.#db
          .prepare(
            `INSERT INTO agent_sessions (agent, session, version, record, updated_at)
             VALUES (?, ?, 1, ?, ?)`,
          )
          .run(key.agent, key.session, record, Date.now());
        return { won: true };
      } catch (cause) {
        // The one failure the contract names an outcome: a first write that
        // lost to another first writer. Everything else is a store failure.
        if (/UNIQUE constraint failed/i.test(messageOf(cause))) {
          return { won: false };
        }
        throw cause;
      }
    });
  }

  async replace(
    key: AgentSessionKey,
    expectedVersion: number,
    value: unknown,
  ): Promise<SessionCasResult> {
    const record = JSON.stringify(value);
    return this.guard("write", () => {
      this.#db
        .prepare(
          `UPDATE agent_sessions
             SET version = version + 1, record = ?, updated_at = ?
           WHERE agent = ? AND session = ? AND version = ?`,
        )
        .run(record, Date.now(), key.agent, key.session, expectedVersion);
      const changed = this.#db.prepare("SELECT changes() AS changed").get() as {
        changed: number;
      };
      return { won: changed.changed === 1 };
    });
  }

  async keys(): Promise<AgentSessionKey[]> {
    const rows = this.guard("read", () =>
      this.#db
        .prepare(
          "SELECT agent, session FROM agent_sessions ORDER BY agent, session",
        )
        .all(),
    ) as Array<{ agent: string; session: string }>;
    return rows.map((row) => ({ agent: row.agent, session: row.session }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  /**
   * Run one statement, turning a driver failure into AI1012 naming the
   * operation. A `won: false` is an outcome and passes through untouched.
   */
  private guard<T>(operation: "read" | "write", run: () => T): T {
    if (this.#closed) {
      throw rcError("AI1012", undefined, {
        message: `The agent session store is closed; a ${operation} arrived after teardown.`,
      });
    }
    try {
      return run();
    } catch (cause) {
      throw rcError("AI1012", cause, {
        message: busy(cause)
          ? `The agent session store was busy during a ${operation}.`
          : `The agent session store failed a ${operation}.`,
      });
    }
  }
}

function initialise(db: SqliteDatabase): void {
  // WAL lets a reader (the management resource) proceed under a writer.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const row = db.prepare("PRAGMA user_version").get() as
    { user_version?: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `schema version ${current} is newer than this build's ${SCHEMA_VERSION}`,
    );
  }
  for (let version = current; version < SCHEMA_VERSION; version++) {
    db.exec(MIGRATIONS[version] as string);
  }
  // Interpolated rather than bound: PRAGMA does not accept parameters.
  if (current !== SCHEMA_VERSION)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function busy(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^SQLITE_BUSY|^SQLITE_LOCKED/.test(code)) {
    return true;
  }
  return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(
    messageOf(cause),
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
