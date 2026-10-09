import { existsSync } from "node:fs";
import {
  CONTINUATIONS,
  claimDatabasePath,
  rcError,
  releaseClaimant,
  resolveDatabasePath,
  resolveSqliteDriver,
  type CraftContext,
  type Plugin,
  type PluginLogger,
  type SqliteDriverLoaders,
} from "@routecraft/routecraft";
import { ADAPTER_AGENT_SESSION_STORE } from "../store.ts";
import { MemorySessionStore } from "./memory-store.ts";
import type { AgentSessionKey } from "./types.ts";
import {
  SESSION_STORE,
  type ResolvedSessionStore,
  type SessionCasResult,
  type SessionStore,
  type SessionWriter,
  type StoredSession,
} from "./port.ts";
import {
  DEFAULT_SESSION_DB_PATH,
  SESSION_SQLITE_CONSUMER,
  SqliteSessionStore,
} from "./sqlite-store.ts";

export type { ResolvedSessionStore } from "./port.ts";

/**
 * Environment variable naming where session records are persisted: a file
 * path, or the literal `memory`. Overridden by an explicit
 * `sessions: { store }`.
 */
export const SESSION_STORE_ENV = "ROUTECRAFT_SESSION_STORE";

/** The setting this store's path claim is reported under. */
const SESSION_CLAIMANT = "sessions: { store }";

/**
 * Where agent session records live.
 *
 * - A path (or `{ path }`) opens the sqlite backend at that location, which
 *   is what a container deployment sets to a mounted volume.
 * - `"memory"` opts into the in-process backend, accepting that every
 *   conversation dies with the process.
 * - A {@link SessionStore} instance plugs in a backend of your own.
 */
export type SessionStoreConfig =
  string | { path: string } | "memory" | SessionStore;

/** The `sessions` block on `defineConfig`. */
export interface AgentSessionsConfig {
  /**
   * Where session records are persisted. Defaults to the sqlite backend at
   * {@link DEFAULT_SESSION_DB_PATH}, created on the first session written,
   * or to whatever {@link SESSION_STORE_ENV} names.
   */
  store?: SessionStoreConfig;
}

/**
 * Seams the test harness needs and users must not have.
 *
 * @internal
 */
export interface SessionStoreTestSeams {
  /** Driver loader injection, for exercising the absent-peer arm. */
  loaders?: SqliteDriverLoaders;
}

/**
 * What resolving a session store needs from whoever resolves it.
 *
 * The host object is also the scope its path claim is recorded in, and no
 * other store claims in it: the deferral store claims in its own plugin
 * context, which no other plugin can reach. A shared file with the
 * continuations store is therefore caught by comparing against
 * `continuationsPath`, the path that store reports through `CONTINUATIONS`.
 *
 * @internal
 */
export interface SessionStoreHost {
  readonly logger: PluginLogger;
  /** The database file the continuations store opened, if it opened one. */
  readonly continuationsPath?: string;
}

/**
 * Resolve the session store for an application.
 *
 * Loud in the degraded case, as the deferral store is: an explicitly
 * named path that cannot be opened fails, because silently keeping a
 * deployment's conversations in memory after it asked for a volume loses
 * the feature's whole promise. The unconfigured default probes the driver
 * now and falls back to memory with a `warn` line when there is none (a
 * Node install without `better-sqlite3`), and otherwise creates the file
 * on the first session written rather than at boot, so a context that
 * never holds a conversation never grows a database.
 *
 * @internal
 */
export async function createSessionStore(
  host: SessionStoreHost,
  config: AgentSessionsConfig & SessionStoreTestSeams = {},
  configured = true,
): Promise<ResolvedSessionStore> {
  // A present-but-empty variable means unset, not "open the working
  // directory as a database".
  const fromEnv = process.env[SESSION_STORE_ENV]?.trim();
  const chosen =
    config.store ??
    (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);

  if (chosen !== undefined && typeof chosen === "object") {
    if (isSessionStore(chosen)) {
      releaseClaimant({ scope: host, claimant: SESSION_CLAIMANT });
      return announce(host, resolved(chosen, "custom", false, configured));
    }
    const path = pathOf(chosen);
    claimSessionPath(host, path);
    return announce(host, await openSqlite(path, config.loaders, configured));
  }
  if (chosen === "memory") {
    releaseClaimant({ scope: host, claimant: SESSION_CLAIMANT });
    return announce(
      host,
      resolved(new MemorySessionStore(), "memory", true, configured),
    );
  }
  if (chosen !== undefined) {
    const path = pathOf(chosen);
    claimSessionPath(host, path);
    return announce(host, await openSqlite(path, config.loaders, configured));
  }

  try {
    await resolveSqliteDriver(SESSION_SQLITE_CONSUMER, config.loaders);
  } catch (err) {
    host.logger.warn(
      { err, path: DEFAULT_SESSION_DB_PATH },
      "No durable agent session store available; conversations will NOT survive a restart. Install better-sqlite3 (Node) or configure sessions: { store } to keep them durable.",
    );
    releaseClaimant({ scope: host, claimant: SESSION_CLAIMANT });
    return announce(
      host,
      resolved(new MemorySessionStore(), "memory", true, configured),
    );
  }
  // Claimed here rather than when the file is first written: the conflict
  // is in the configuration, so it is reported while a person is still
  // reading boot output, not on whichever conversation happens to be first.
  claimSessionPath(host, DEFAULT_SESSION_DB_PATH);
  return announce(
    host,
    resolved(
      new LazySqliteSessionStore(DEFAULT_SESSION_DB_PATH, config.loaders),
      "sqlite",
      true,
      configured,
    ),
  );
}

/**
 * Reserve the file this store will open, so a path shared with another
 * store is one error at boot naming both settings rather than two stores
 * disagreeing about a version later.
 */
function claimSessionPath(host: SessionStoreHost, path: string): void {
  const continuations = host.continuationsPath;
  if (
    continuations !== undefined &&
    path !== ":memory:" &&
    resolveDatabasePath(continuations) === resolveDatabasePath(path)
  ) {
    throw sharedPath("deferral: { store }", path);
  }
  claimDatabasePath({
    scope: host,
    path,
    claimant: SESSION_CLAIMANT,
    onConflict: (conflict) => sharedPath(conflict.held, conflict.path),
  });
}

function sharedPath(held: string, path: string): Error {
  return rcError("AI1012", undefined, {
    message: `sessions: { store } and ${held} both point at "${path}". Each store versions its own file, so they cannot share one; give them separate paths.`,
  });
}

/**
 * Whether the value is a backend rather than a location. Every operation is
 * checked, not one: a near-miss (a method misspelt, a half-written class)
 * would otherwise be read as a path and reported as a file that cannot be
 * opened, which points nowhere near the mistake.
 */
function isSessionStore(value: object): value is SessionStore {
  const candidate = value as Record<string, unknown>;
  return (
    ["get", "create", "replace", "keys", "remove", "close"] as const
  ).every((operation) => typeof candidate[operation] === "function");
}

/** The location a config value names, refusing what names nothing. */
function pathOf(chosen: string | { path: string } | object): string {
  const path =
    typeof chosen === "object" ? (chosen as { path?: unknown }).path : chosen;
  if (typeof path !== "string" || path.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `sessions: { store } takes a file path, { path }, "memory", or a SessionStore with get, create, replace, keys, remove and close. Received ${describe(chosen)}.`,
    });
  }
  return path;
}

function describe(value: unknown): string {
  if (typeof value === "string") return `the string "${value}"`;
  if (value === null) return "null";
  if (typeof value !== "object") return `a ${typeof value}`;
  const keys = Object.keys(value);
  return keys.length === 0
    ? "an object with no keys"
    : `an object with ${keys.join(", ")}`;
}

async function openSqlite(
  path: string,
  loaders: SqliteDriverLoaders | undefined,
  configured: boolean,
): Promise<ResolvedSessionStore> {
  const store = await SqliteSessionStore.open({
    path,
    ...(loaders ? { loaders } : {}),
  });
  return resolved(store, "sqlite", true, configured, store.driver);
}

/** One startup line per resolution, so the memory fallback shows in the log. */
function announce(
  host: SessionStoreHost,
  choice: ResolvedSessionStore,
): ResolvedSessionStore {
  host.logger.debug(
    { backend: choice.backend, driver: choice.driver },
    "Agent session store resolved",
  );
  return choice;
}

/**
 * The application's session store: the one the sessions plugin provides,
 * or, for the inline `agent({ session })` form in an application with no
 * sessions plugin, a default resolved on first use. The fallback is the
 * same resolution the plugin runs ({@link createSessionStore} with no
 * block: the environment variable, the driver probe, the memory fallback),
 * deferred to the first use because this is called synchronously, and
 * closed once the context has stopped since no plugin owns it.
 *
 * @internal
 */
export function sessionStoreOf(context: CraftContext): ResolvedSessionStore {
  const provided = context.lookup(SESSION_STORE);
  if (provided) return provided;
  const existing = context.getStore(ADAPTER_AGENT_SESSION_STORE);
  if (existing) return existing;
  const fallback = new LazyResolvedSessionStore(() => {
    // The same path check the sessions plugin makes: a store resolved from
    // the environment must not open the file the continuations store holds.
    const continuationsPath = context.lookup(CONTINUATIONS)?.path;
    return createSessionStore(
      {
        logger: context.logger,
        ...(continuationsPath !== undefined ? { continuationsPath } : {}),
      },
      {},
      false,
    );
  });
  context.setStore(ADAPTER_AGENT_SESSION_STORE, fallback);
  context.on("context:stopped", () => {
    void fallback.close();
  });
  return fallback;
}

/**
 * The sessions plugin, wired to the `sessions` config key. Resolves the
 * store during bind so a path that cannot be opened fails at startup, and
 * closes it at stop after every session runtime retained on it has stopped,
 * so no revival in flight writes to a closed store.
 *
 * Without a `sessions` block the agent runtime brings along the default
 * form of this plugin, and a block in config takes its place.
 */
export function sessionsPlugin(config: AgentSessionsConfig = {}): Plugin {
  return sessionsPluginFor(config, true);
}

/**
 * The unconfigured default the agent runtime brings along.
 *
 * @internal
 */
export function defaultSessionsPlugin(): Plugin {
  return (defaultSessions ??= sessionsPluginFor({}, false));
}

// One descriptor per process, so every runtime brings the same one.
let defaultSessions: Plugin | undefined;

function sessionsPluginFor(
  config: AgentSessionsConfig,
  configured: boolean,
): Plugin {
  return {
    id: "routecraft.ai.sessions",
    provides: [SESSION_STORE],
    optional: [CONTINUATIONS],
    async bind(c) {
      const continuationsPath = c.lookup(CONTINUATIONS)?.path;
      const store = await createSessionStore(
        {
          logger: c.logger,
          ...(continuationsPath !== undefined ? { continuationsPath } : {}),
        },
        config,
        configured,
      );
      c.onDispose(() => store.close());
      c.provide(SESSION_STORE, store);
    },
  };
}

function resolved(
  store: SessionStore,
  backend: ResolvedSessionStore["backend"],
  ownsStore: boolean,
  configured: boolean,
  driver?: string,
): ResolvedSessionStore {
  const writers: SessionWriter[] = [];
  let closed = false;
  return {
    store,
    backend,
    ownsStore,
    configured,
    ...(driver !== undefined ? { driver } : {}),
    retain(writer) {
      writers.push(writer);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(writers.map((writer) => writer.stop()));
      if (ownsStore) await store.close();
    },
  };
}

/**
 * A store resolved on first use. Stands in for the context's store until
 * something touches it, then delegates to whatever the resolution chose,
 * and reports that choice from then on.
 */
class LazyResolvedSessionStore implements ResolvedSessionStore, SessionStore {
  #inner: Promise<ResolvedSessionStore> | undefined;
  #closed = false;
  readonly #writers: SessionWriter[] = [];

  constructor(private readonly open: () => Promise<ResolvedSessionStore>) {}

  get store(): SessionStore {
    return this;
  }

  get backend(): ResolvedSessionStore["backend"] {
    // Reported rather than guessed: which backend this becomes is not
    // decided until something uses it, and the default is not always sqlite.
    return this.#chosen?.backend ?? "unresolved";
  }

  get ownsStore(): boolean {
    return this.#chosen?.ownsStore ?? true;
  }

  readonly configured = false;

  /** The resolution once it settled; undefined while it has not run or is still running. */
  #chosen: ResolvedSessionStore | undefined;

  retain(writer: SessionWriter): void {
    this.#writers.push(writer);
  }

  async get(key: AgentSessionKey): Promise<StoredSession | undefined> {
    return (await this.resolve()).store.get(key);
  }

  async create(
    key: AgentSessionKey,
    value: unknown,
  ): Promise<SessionCasResult> {
    return (await this.resolve()).store.create(key, value);
  }

  async replace(
    key: AgentSessionKey,
    expectedVersion: number,
    value: unknown,
  ): Promise<SessionCasResult> {
    return (await this.resolve()).store.replace(key, expectedVersion, value);
  }

  async keys(): Promise<AgentSessionKey[]> {
    return (await this.resolve()).store.keys();
  }

  async remove(key: AgentSessionKey): Promise<void> {
    await (await this.resolve()).store.remove(key);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled(this.#writers.map((writer) => writer.stop()));
    if (this.#inner) await (await this.#inner).close();
  }

  private resolve(): Promise<ResolvedSessionStore> {
    // A call after the context released the store must not reopen it.
    if (this.#closed) {
      throw rcError("AI1012", undefined, {
        message:
          "The agent session store is closed; a call arrived after teardown.",
      });
    }
    this.#inner ??= this.open().then(
      (chosen) => {
        this.#chosen = chosen;
        return chosen;
      },
      (err: unknown) => {
        // A failed resolution is not the store's state; the next use retries.
        this.#inner = undefined;
        throw err;
      },
    );
    return this.#inner;
  }
}

/**
 * The default sqlite store, opened on the first write. A read before the
 * file exists answers empty without creating it, so a boot that walks the
 * sessions of a deployment that never held one leaves no database behind.
 *
 * @internal
 */
export class LazySqliteSessionStore implements SessionStore {
  #opened: Promise<SqliteSessionStore> | undefined;

  constructor(
    private readonly path: string,
    private readonly loaders?: SqliteDriverLoaders,
  ) {}

  async get(key: AgentSessionKey): Promise<StoredSession | undefined> {
    return (await this.reader())?.get(key);
  }

  async create(
    key: AgentSessionKey,
    value: unknown,
  ): Promise<SessionCasResult> {
    return (await this.open()).create(key, value);
  }

  async replace(
    key: AgentSessionKey,
    expectedVersion: number,
    value: unknown,
  ): Promise<SessionCasResult> {
    return (await this.open()).replace(key, expectedVersion, value);
  }

  async keys(): Promise<AgentSessionKey[]> {
    return (await this.reader())?.keys() ?? [];
  }

  async remove(key: AgentSessionKey): Promise<void> {
    // Through the reader, so deleting from a deployment that never wrote a
    // session does not create the database it would delete from.
    await (await this.reader())?.remove(key);
  }

  async close(): Promise<void> {
    if (!this.#opened) return;
    await (await this.#opened).close();
  }

  private open(): Promise<SqliteSessionStore> {
    this.#opened ??= SqliteSessionStore.open({
      path: this.path,
      ...(this.loaders ? { loaders: this.loaders } : {}),
    }).catch((err: unknown) => {
      // A failed open is not the store's state; the next write tries again.
      this.#opened = undefined;
      throw err;
    });
    return this.#opened;
  }

  private async reader(): Promise<SqliteSessionStore | undefined> {
    if (this.#opened) return this.#opened;
    // The same resolution the open uses, so the probe and the open cannot
    // look at two different files.
    if (!existsSync(resolveDatabasePath(this.path))) return undefined;
    return this.open();
  }
}
