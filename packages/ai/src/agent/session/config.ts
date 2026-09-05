import { existsSync } from "node:fs";
import {
  rcError,
  resolveDatabasePath,
  resolveSqliteDriver,
  type CraftContext,
  type CraftPlugin,
  type SqliteDriverLoaders,
} from "@routecraft/routecraft";
import {
  ADAPTER_AGENT_SESSION_STORE,
  ADAPTER_AGENT_SESSIONS,
} from "../store.ts";
import { MemorySessionStore } from "./memory-store.ts";
import type { AgentSessionKey } from "./types.ts";
import type { SessionCasResult, SessionStore, StoredSession } from "./port.ts";
import {
  DEFAULT_SESSION_DB_PATH,
  SESSION_SQLITE_CONSUMER,
  SqliteSessionStore,
} from "./sqlite-store.ts";

/**
 * Environment variable naming where session records are persisted: a file
 * path, or the literal `memory`. Overridden by an explicit
 * `sessions: { store }`.
 */
export const SESSION_STORE_ENV = "ROUTECRAFT_SESSION_STORE";

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
 * The store a context resolved, with what it resolved to for the log line
 * and whether this context owns its lifecycle.
 *
 * @internal
 */
export interface ResolvedSessionStore {
  readonly store: SessionStore;
  /**
   * `custom` is a store the caller supplied; reporting it as `sqlite` would
   * mislead exactly the operator who configured a backend deliberately.
   * `unresolved` is the lazy form before anything touched it, which is the
   * one state where the answer is not yet known.
   */
  readonly backend: "sqlite" | "memory" | "custom" | "unresolved";
  /** Which sqlite driver opened it, where one did. */
  readonly driver?: string;
  /**
   * False when the caller supplied the store, in which case they own its
   * lifecycle and teardown must not close it.
   */
  readonly ownsStore: boolean;
  /**
   * Whether a `sessions` block chose this store. An unconfigured default an
   * `agentPlugin()` opened first is replaced by the block's choice, whichever
   * plugin applied first.
   */
  readonly configured: boolean;
  /** Close the store if this context owns it. Idempotent. */
  close(): Promise<void>;
}

/**
 * Resolve the session store for a context.
 *
 * Loud in the degraded case, as the suspension store is: an explicitly
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
  context: CraftContext,
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
      return announce(context, resolved(chosen, "custom", false, configured));
    }
    return announce(
      context,
      await openSqlite(pathOf(chosen), config.loaders, configured),
    );
  }
  if (chosen === "memory") {
    return announce(
      context,
      resolved(new MemorySessionStore(), "memory", true, configured),
    );
  }
  if (chosen !== undefined) {
    return announce(
      context,
      await openSqlite(pathOf(chosen), config.loaders, configured),
    );
  }

  try {
    await resolveSqliteDriver(SESSION_SQLITE_CONSUMER, config.loaders);
  } catch (err) {
    context.logger.warn(
      { err, path: DEFAULT_SESSION_DB_PATH },
      "No durable agent session store available; conversations will NOT survive a restart. Install better-sqlite3 (Node) or configure sessions: { store } to keep them durable.",
    );
    return announce(
      context,
      resolved(new MemorySessionStore(), "memory", true, configured),
    );
  }
  return announce(
    context,
    resolved(
      new DeferredSqliteSessionStore(DEFAULT_SESSION_DB_PATH, config.loaders),
      "sqlite",
      true,
      configured,
    ),
  );
}

/**
 * Whether the value is a backend rather than a location. Every operation is
 * checked, not one: a near-miss (a method misspelt, a half-written class)
 * would otherwise be read as a path and reported as a file that cannot be
 * opened, which points nowhere near the mistake.
 */
function isSessionStore(value: object): value is SessionStore {
  const candidate = value as Record<string, unknown>;
  return (["get", "create", "replace", "keys", "close"] as const).every(
    (operation) => typeof candidate[operation] === "function",
  );
}

/** The location a config value names, refusing what names nothing. */
function pathOf(chosen: string | { path: string } | object): string {
  const path =
    typeof chosen === "object" ? (chosen as { path?: unknown }).path : chosen;
  if (typeof path !== "string" || path.trim() === "") {
    throw rcError("RC5003", undefined, {
      message: `sessions: { store } takes a file path, { path }, "memory", or a SessionStore with get, create, replace, keys and close. Received ${describe(chosen)}.`,
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
  context: CraftContext,
  choice: ResolvedSessionStore,
): ResolvedSessionStore {
  context.logger.debug(
    { backend: choice.backend, driver: choice.driver },
    "Agent session store resolved",
  );
  return choice;
}

/**
 * The context's session store, resolving the default when no plugin has:
 * the inline `agent({ session })` form needs no `agentPlugin()`, and a
 * store must exist by the time its first turn runs. The resolution is the
 * same one the plugins run ({@link createSessionStore} with no block: the
 * environment variable, the driver probe, the memory fallback), deferred to
 * the first use because this is called synchronously, and closed once the
 * context has stopped since no plugin owns it.
 *
 * @internal
 */
export function sessionStoreOf(context: CraftContext): SessionStore {
  const existing = context.getStore(ADAPTER_AGENT_SESSION_STORE);
  if (existing) return existing.store;
  const fallback = new LazyResolvedSessionStore(() =>
    createSessionStore(context, {}, false),
  );
  context.setStore(ADAPTER_AGENT_SESSION_STORE, fallback);
  context.on("context:stopped", () => {
    void fallback.close();
  });
  return fallback.store;
}

/**
 * Plugin form of {@link createSessionStore}, wired to the `sessions` config
 * key. Resolves the store during `initPlugins()` so a path that cannot be
 * opened fails at startup, and closes it at teardown after the session
 * runtime has stopped, so no revival in flight writes to a closed store.
 */
export function sessionsPlugin(config: AgentSessionsConfig = {}): CraftPlugin {
  return {
    name: "agent-sessions",
    async apply(ctx: CraftContext) {
      const existing = ctx.getStore(ADAPTER_AGENT_SESSION_STORE);
      if (existing?.configured) {
        throw rcError("RC5003", undefined, {
          message:
            "sessions: { store } is configured twice in this context. One `sessions` block chooses where every agent session lives.",
        });
      }
      await existing?.close();
      ctx.setStore(
        ADAPTER_AGENT_SESSION_STORE,
        await createSessionStore(ctx, config),
      );
    },
    teardown: stopSessions,
  };
}

/**
 * Stop the session runtime, then release the store it writes to. The order
 * is the contract: a revival still in flight must not write to a closed
 * store, and a context that installed `agentPlugin()` waits for its boot
 * walk before either.
 *
 * @internal
 */
export async function stopSessions(ctx: CraftContext): Promise<void> {
  await ctx.getStore(ADAPTER_AGENT_SESSIONS)?.stop();
  await ctx.getStore(ADAPTER_AGENT_SESSION_STORE)?.close();
}

function resolved(
  store: SessionStore,
  backend: ResolvedSessionStore["backend"],
  ownsStore: boolean,
  configured: boolean,
  driver?: string,
): ResolvedSessionStore {
  let closed = false;
  return {
    store,
    backend,
    ownsStore,
    configured,
    ...(driver !== undefined ? { driver } : {}),
    async close() {
      if (closed || !ownsStore) return;
      closed = true;
      await store.close();
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
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
export class DeferredSqliteSessionStore implements SessionStore {
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
