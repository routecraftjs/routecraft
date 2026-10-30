import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { isRoutecraftError } from "../../brand.ts";
import { rcError } from "../../error.ts";
import {
  resolveSqliteDriver,
  type SqliteDatabase,
  type SqliteDriverLoaders,
  type SqliteDriverName,
} from "../../shared/sqlite/driver.ts";
import {
  describeSqliteFile,
  isSqliteBusy,
  migrateSqlite,
  resolveDatabasePath,
  sqliteChanges,
  SQLITE_APPLICATION_IDS,
} from "../../shared/sqlite/database.ts";
import type { CredentialSealer } from "./seal.ts";
import type {
  CredentialStore,
  CredentialWrite,
  StoredCredential,
} from "./types.ts";

/** Where credentials are kept when nothing else is configured. */
export const DEFAULT_CREDENTIALS_DB_PATH = ".routecraft/credentials.db";

const SQLITE_CONSUMER = "credential store (sqlite)";
const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;

/** Index `n` migrates version `n` to `n + 1`. */
const MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE credentials (
     owner TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     version INTEGER NOT NULL,
     issued_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
];

/** A stored value is plain JSON, or sealed and marked so. */
const SEALED_PREFIX = "sealed:v1:";

interface Row {
  owner: string;
  value: string;
  version: number;
  issued_at: number;
  updated_at: number;
}

/**
 * Credentials in a SQLite file readable only by its owner (mode 0600), and
 * sealed with AES-256-GCM when a key is configured.
 *
 * The rollback journal is used rather than WAL: credentials are written a
 * few times an hour, and WAL leaves two more files beside the database that
 * hold recent writes and would need the same permissions.
 */
export class SqliteCredentialStore implements CredentialStore {
  readonly #db: SqliteDatabase;
  readonly #sealer: CredentialSealer | undefined;
  readonly driver: SqliteDriverName;

  private constructor(
    db: SqliteDatabase,
    driver: SqliteDriverName,
    sealer: CredentialSealer | undefined,
  ) {
    this.#db = db;
    this.driver = driver;
    this.#sealer = sealer;
  }

  /**
   * Open (creating when absent) the store at `path`.
   *
   * @throws RC5017 under Node without `better-sqlite3`
   * @throws RC5070 when the file belongs to another store or cannot be migrated
   */
  static async open(options: {
    path: string;
    sealer?: CredentialSealer | undefined;
    loaders?: SqliteDriverLoaders;
  }): Promise<SqliteCredentialStore> {
    const driver = await resolveSqliteDriver(SQLITE_CONSUMER, options.loaders);
    const path = resolveDatabasePath(options.path);
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
      // Created owner-only before the driver opens it, so the file never
      // exists with the default umask's permissions.
      if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
      try {
        chmodSync(path, 0o600);
      } catch {
        // A file the process can open but not chmod (another owner, a
        // read-only mount's metadata) keeps whatever mode it has.
      }
    }
    const db = new driver.Database(path);
    try {
      db.exec("PRAGMA journal_mode = DELETE");
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      migrateSqlite(db, {
        schemaVersion: SCHEMA_VERSION,
        migrations: MIGRATIONS,
        applicationId: SQLITE_APPLICATION_IDS.credentials,
        identityTable: "credentials",
        onFailure: (failure) => {
          if (failure.kind === "foreign") {
            return rcError("RC5070", undefined, {
              message: `This file is not a credential store; ${describeSqliteFile(failure)}. Point credentials.store at its own file: every store keeps one, and they cannot share.`,
            });
          }
          if (failure.kind === "downgrade") {
            return rcError("RC5070", undefined, {
              message: `Credential store schema version ${failure.current} is newer than this build understands (${SCHEMA_VERSION}). Run the newer Routecraft build.`,
            });
          }
          return rcError("RC5070", failure.cause, {
            message: "Failed to migrate the credential store schema.",
          });
        },
      });
    } catch (cause) {
      try {
        db.close();
      } catch {
        // Already unusable; the original cause is what matters.
      }
      if (isRoutecraftError(cause)) throw cause;
      throw rcError("RC5070", cause, {
        message: isSqliteBusy(cause)
          ? `The credential store at ${path} is locked by another process.`
          : `The credential store at ${path} could not be opened.`,
      });
    }
    return new SqliteCredentialStore(db, driver.name, options.sealer);
  }

  async get(owner: string): Promise<StoredCredential | undefined> {
    const row = this.#guard(`read the credential of "${owner}"`, () =>
      this.#db.prepare(`SELECT * FROM credentials WHERE owner = ?`).get(owner),
    ) as Row | undefined | null;
    return row ? this.#decode(row) : undefined;
  }

  async put(
    owner: string,
    value: unknown,
    options: { readonly ifVersion: number | null; readonly issuedAt?: number },
  ): Promise<CredentialWrite> {
    const encoded = this.#encode(owner, value);
    const now = Date.now();
    const changed = this.#guard(`write the credential of "${owner}"`, () => {
      if (options.ifVersion === null) {
        this.#db
          .prepare(
            `INSERT INTO credentials (owner, value, version, issued_at, updated_at)
             VALUES (?, ?, 1, ?, ?) ON CONFLICT (owner) DO NOTHING`,
          )
          .run(owner, encoded, options.issuedAt ?? now, now);
      } else {
        this.#db
          .prepare(
            `UPDATE credentials
               SET value = ?, version = version + 1,
                   issued_at = COALESCE(?, issued_at), updated_at = ?
             WHERE owner = ? AND version = ?`,
          )
          .run(
            encoded,
            options.issuedAt ?? null,
            now,
            owner,
            options.ifVersion,
          );
      }
      return sqliteChanges(this.#db);
    });
    if (changed === 1) {
      return {
        written: true,
        version: options.ifVersion === null ? 1 : options.ifVersion + 1,
      };
    }
    return { written: false, current: await this.get(owner) };
  }

  async delete(
    owner: string,
    options: { readonly ifVersion?: number } = {},
  ): Promise<boolean> {
    const changed = this.#guard(`delete the credential of "${owner}"`, () => {
      if (options.ifVersion === undefined) {
        this.#db.prepare(`DELETE FROM credentials WHERE owner = ?`).run(owner);
      } else {
        this.#db
          .prepare(`DELETE FROM credentials WHERE owner = ? AND version = ?`)
          .run(owner, options.ifVersion);
      }
      return sqliteChanges(this.#db);
    });
    return changed === 1;
  }

  async list(): Promise<Array<StoredCredential & { readonly owner: string }>> {
    const rows = this.#guard("list credentials", () =>
      this.#db.prepare(`SELECT * FROM credentials ORDER BY owner`).all(),
    ) as Row[];
    return rows.map((row) => ({ owner: row.owner, ...this.#decode(row) }));
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  #encode(owner: string, value: unknown): string {
    const json = JSON.stringify(value);
    return this.#sealer
      ? `${SEALED_PREFIX}${this.#sealer.seal(json, `credential:${owner}`)}`
      : json;
  }

  #decode(row: Row): StoredCredential {
    let json = row.value;
    if (json.startsWith(SEALED_PREFIX)) {
      if (!this.#sealer) {
        throw rcError("RC5070", undefined, {
          message: `The credential of "${row.owner}" is sealed, and ROUTECRAFT_CREDENTIALS_KEY is not set. Set the key it was sealed under.`,
        });
      }
      json = this.#sealer.open(
        json.slice(SEALED_PREFIX.length),
        `credential:${row.owner}`,
      );
    }
    return {
      value: JSON.parse(json) as unknown,
      version: row.version,
      issuedAt: row.issued_at,
      updatedAt: row.updated_at,
    };
  }

  #guard<T>(what: string, work: () => T): T {
    try {
      return work();
    } catch (cause) {
      throw rcError("RC5070", cause, {
        message: isSqliteBusy(cause)
          ? `The credential store was busy and could not ${what}.`
          : `The credential store could not ${what}.`,
      });
    }
  }
}
