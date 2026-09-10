import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimDatabasePath,
  MemoryDeferralStore,
  resolveSqliteDriver,
  SQLITE_APPLICATION_IDS,
  SqliteDeferralStore,
  type SqliteDriverLoaders,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { agentPlugin, llmPlugin } from "../src/index.ts";
import {
  AgentSessionRuntime,
  DEFAULT_SESSION_DB_PATH,
  MemorySessionStore,
  SESSION_STORE_ENV,
  SqliteSessionStore,
} from "../src/agent/session/index.ts";
import {
  createSessionStore,
  LazySqliteSessionStore,
} from "../src/agent/session/config.ts";
import { ADAPTER_AGENT_SESSION_STORE } from "../src/agent/store.ts";
import { MODEL } from "./helpers/defer-fixtures.ts";

const scratch = mkdtempSync(join(tmpdir(), "rc-sessions-config-"));
const key = "s";

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Loaders for a runtime that has no sqlite driver at all. */
const absentDriver: SqliteDriverLoaders = {
  bun: () => Promise.reject(new Error("no bun:sqlite here")),
  node: () => Promise.reject(new Error("no better-sqlite3 here")),
};

describe("session store resolution", () => {
  let t: TestContext | undefined;
  const env = process.env[SESSION_STORE_ENV];

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
    if (env === undefined) delete process.env[SESSION_STORE_ENV];
    else process.env[SESSION_STORE_ENV] = env;
  });

  /**
   * @case The literal "memory" opts into the in-process backend the context owns
   * @preconditions sessions: { store: "memory" }
   * @expectedResult The resolved backend is memory, owned by the context, and configured
   */
  test("memory by name", async () => {
    t = await testContext().build();
    const resolved = await createSessionStore(t.ctx, { store: "memory" });
    expect(resolved.backend).toBe("memory");
    expect(resolved.ownsStore).toBe(true);
    expect(resolved.configured).toBe(true);
    expect(resolved.store).toBeInstanceOf(MemorySessionStore);
  });

  /**
   * @case A store instance the caller supplies is used as is and never closed by the context
   * @preconditions sessions: { store } with a MemorySessionStore whose close() is counted
   * @expectedResult The backend reads custom, ownsStore is false, and the resolved close() leaves the store's own close() uncalled
   */
  test("a supplied store is not owned", async () => {
    t = await testContext().build();
    const own = new MemorySessionStore();
    let closes = 0;
    own.close = async () => {
      closes += 1;
    };
    const resolved = await createSessionStore(t.ctx, { store: own });
    expect(resolved.backend).toBe("custom");
    expect(resolved.ownsStore).toBe(false);
    expect(resolved.store).toBe(own);
    await resolved.close();
    expect(closes).toBe(0);
  });

  /**
   * @case An explicit path is opened at once, so a path that cannot hold a database fails resolution rather than the first conversation
   * @preconditions sessions: { store: { path } } where the path's parent is a regular file
   * @expectedResult createSessionStore rejects with AI1012
   */
  test("an explicit path that cannot be opened fails loudly", async () => {
    t = await testContext().build();
    const blocker = join(scratch, "blocker");
    writeFileSync(blocker, "a file");
    await expect(
      createSessionStore(t.ctx, { store: { path: join(blocker, "s.db") } }),
    ).rejects.toMatchObject({ rc: "AI1012" });
  });

  /**
   * @case An explicit path opens the sqlite backend and the file exists once opened
   * @preconditions sessions: { store: "<scratch>/explicit.db" } as a bare string
   * @expectedResult The backend is sqlite, the store is a SqliteSessionStore, and the file exists
   */
  test("a path string opens sqlite", async () => {
    t = await testContext().build();
    const path = join(scratch, "explicit.db");
    const resolved = await createSessionStore(t.ctx, { store: path });
    expect(resolved.backend).toBe("sqlite");
    expect(resolved.store).toBeInstanceOf(SqliteSessionStore);
    expect(existsSync(path)).toBe(true);
    await resolved.close();
  });

  /**
   * @case The environment names the store when the config does not, and a blank variable means unset
   * @preconditions ROUTECRAFT_SESSION_STORE=memory with no sessions block; then the variable set to whitespace
   * @expectedResult The first resolution is the memory backend; the second is the sqlite default
   */
  test("the environment variable is read when config is silent", async () => {
    t = await testContext().build();
    process.env[SESSION_STORE_ENV] = "memory";
    expect((await createSessionStore(t.ctx, {})).backend).toBe("memory");
    process.env[SESSION_STORE_ENV] = "   ";
    const resolved = await createSessionStore(t.ctx, {});
    expect(resolved.backend).toBe("sqlite");
    expect(resolved.store).toBeInstanceOf(LazySqliteSessionStore);
  });

  /**
   * @case Without a driver the unconfigured default falls back to memory and warns, naming the consequence
   * @preconditions No sessions block; the driver loaders both reject
   * @expectedResult The backend is memory, and one warn line says conversations will not survive a restart
   */
  test("the default falls back to memory with a warning when no driver exists", async () => {
    t = await testContext().build();
    const warnings: string[] = [];
    t.ctx.logger.warn = ((...args: unknown[]) => {
      const message = args.find((a) => typeof a === "string");
      if (typeof message === "string") warnings.push(message);
    }) as unknown as typeof t.ctx.logger.warn;
    const resolved = await createSessionStore(t.ctx, { loaders: absentDriver });
    expect(resolved.backend).toBe("memory");
    expect(warnings.at(-1)).toContain("will NOT survive a restart");
  });

  /**
   * @case The default store creates its file on the first write, never on a read
   * @preconditions A deferred store on a scratch path that does not exist; get() and keys() are called, then create()
   * @expectedResult The reads answer empty and the file is still absent; after the write the file exists and a fresh SqliteSessionStore on the path reads the record
   */
  test("the default store is created by the first write", async () => {
    const path = join(scratch, "deferred", "sessions.db");
    const store = new LazySqliteSessionStore(path);
    expect(await store.get(key)).toBeUndefined();
    expect(await store.keys()).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(await store.create(key, { turns: 1 })).toEqual({ won: true });
    expect(existsSync(path)).toBe(true);
    await store.close();
    const reopened = await SqliteSessionStore.open({ path });
    expect(await reopened.get(key)).toEqual({
      value: { turns: 1 },
      version: 1,
    });
    await reopened.close();
  });

  /**
   * @case The sessions config key chooses the context's store, whichever plugin applied first
   * @preconditions A context with agentPlugin() in plugins and sessions: { store } in config, so the plugin's unconfigured default and the block's choice both apply
   * @expectedResult The context's resolved store is the configured one, reported as custom
   */
  test("the sessions key wins over the plugin's default", async () => {
    const own = new MemorySessionStore();
    t = await testContext()
      .with({
        deferral: { store: new MemoryDeferralStore() },
        sessions: { store: own },
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            agents: { max: { description: "Max", model: MODEL, system: "x" } },
          }),
        ],
      })
      .build();
    const resolved = t.ctx.getStore(ADAPTER_AGENT_SESSION_STORE);
    expect(resolved?.store).toBe(own);
    expect(resolved?.configured).toBe(true);
    expect(resolved?.backend).toBe("custom");
  });

  /**
   * @case A store value that names neither a location nor a backend is refused at the boundary
   * @preconditions sessions: { store } given an object missing one contract operation, an object with no path, and an empty string
   * @expectedResult Each is RC5003 naming what the key accepts, rather than a driver or path error further in
   */
  test("a store that is neither a path nor a backend is RC5003", async () => {
    t = await testContext()
      .with({ deferral: { store: new MemoryDeferralStore() } })
      .build();
    const halfWritten = {
      get: () => undefined,
      create: () => undefined,
      keys: () => [],
      close: () => undefined,
    };
    for (const store of [
      halfWritten as never,
      {} as never,
      "" as never,
      "   " as never,
    ]) {
      await expect(createSessionStore(t.ctx, { store })).rejects.toThrow(
        /RC5003|takes a file path/,
      );
    }
  });

  /**
   * @case The lazy fallback reports no backend until something resolves it
   * @preconditions A context with a deferral block and no session-owning plugin, read before any session work
   * @expectedResult The resolved store reports the unresolved backend rather than guessing sqlite
   */
  test("the inline fallback reports no backend before it resolves", async () => {
    t = await testContext()
      .with({ deferral: { store: new MemoryDeferralStore() } })
      .build();
    AgentSessionRuntime.for(t.ctx);
    expect(t.ctx.getStore(ADAPTER_AGENT_SESSION_STORE)?.backend).toBe(
      "unresolved",
    );
  });

  /**
   * @case An inline session with no session-owning plugin resolves its store the way the plugins do, environment included
   * @preconditions A context with a deferral block and neither agentPlugin() nor a sessions key; ROUTECRAFT_SESSION_STORE=memory; the runtime is created for the context and used once
   * @expectedResult The context's resolved store reports the memory backend after that use and is unconfigured
   */
  test("the inline fallback resolves like the plugins", async () => {
    process.env[SESSION_STORE_ENV] = "memory";
    t = await testContext()
      .with({ deferral: { store: new MemoryDeferralStore() } })
      .build();
    const runtime = AgentSessionRuntime.for(t.ctx);
    expect(await runtime.store.list()).toEqual([]);
    const resolved = t.ctx.getStore(ADAPTER_AGENT_SESSION_STORE);
    expect(resolved?.backend).toBe("memory");
    expect(resolved?.configured).toBe(false);
  });

  /**
   * @case The inline fallback refuses work once the context has stopped, rather than reopening a store it released
   * @preconditions A context with a deferral block and no session-owning plugin; the runtime is created, the context is stopped, and a session read is attempted afterwards
   * @expectedResult The read rejects with AI1012 naming a call after teardown
   */
  test("the inline fallback stays closed after the context stops", async () => {
    process.env[SESSION_STORE_ENV] = "memory";
    const ctx = await testContext()
      .with({ deferral: { store: new MemoryDeferralStore() } })
      .build();
    const runtime = AgentSessionRuntime.for(ctx.ctx);
    await ctx.stop();
    await expect(runtime.store.list()).rejects.toMatchObject({
      rc: "AI1012",
      message: expect.stringContaining("after teardown"),
    });
  });

  /**
   * @case An agentPlugin without a sessions key resolves a default the context owns
   * @preconditions A context with agentPlugin() and no sessions key
   * @expectedResult The resolved store is the deferred sqlite default, unconfigured and owned
   */
  test("agentPlugin resolves the default when no key is set", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({
            agents: { max: { description: "Max", model: MODEL, system: "x" } },
          }),
        ],
      })
      .build();
    const resolved = t.ctx.getStore(ADAPTER_AGENT_SESSION_STORE);
    expect(resolved?.configured).toBe(false);
    expect(resolved?.ownsStore).toBe(true);
    expect(resolved?.store).toBeInstanceOf(LazySqliteSessionStore);
  });

  /**
   * @case A database written by the prerelease schema opens, migrates, and works
   * @preconditions A file carrying the version 1 table, keyed by (agent, session) with a NOT NULL agent column, and `user_version` still at 1
   * @expectedResult It comes up at version 2 keyed by the session id alone, and a create and a read both work. Before the version bump this file kept its old table, because `CREATE TABLE IF NOT EXISTS` does not alter one, and the first write failed on the obsolete column
   */
  test("a version 1 database migrates to the session-keyed schema", async () => {
    const path = join(scratch, "v1.db");
    const driver = await resolveSqliteDriver("test");
    const seed = new driver.Database(path);
    seed.exec(`CREATE TABLE agent_sessions (
       agent      TEXT    NOT NULL,
       session    TEXT    NOT NULL,
       version    INTEGER NOT NULL,
       record     TEXT    NOT NULL,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (agent, session)
     );`);
    seed.exec("INSERT INTO agent_sessions VALUES ('max', 'old', 1, '{}', 0)");
    seed.exec("PRAGMA user_version = 1");
    seed.close();

    const store = await SqliteSessionStore.open({ path });
    // The prerelease row is gone, which the changeset says out loud.
    expect(await store.keys()).toEqual([]);
    expect(await store.create(key, { kind: "agent-session" })).toEqual({
      won: true,
    });
    expect((await store.get(key))?.value).toEqual({ kind: "agent-session" });
    await store.close();

    const check = new driver.Database(path);
    const row = check.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(row.user_version).toBe(2);
    check.close();
  });

  /**
   * @case A fresh database lands on the current version, and reopening it migrates nothing
   * @preconditions A path with no file, opened twice
   * @expectedResult Version 2 both times, and the record written by the first open is still there after the second, so an already-current file is left alone
   */
  test("a fresh database opens at the current version and stays there", async () => {
    const path = join(scratch, "fresh.db");
    const first = await SqliteSessionStore.open({ path });
    await first.create(key, { kind: "agent-session" });
    await first.close();

    const second = await SqliteSessionStore.open({ path });
    expect((await second.get(key))?.value).toEqual({ kind: "agent-session" });
    await second.close();

    const driver = await resolveSqliteDriver("test");
    const check = new driver.Database(path);
    const row = check.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(row.user_version).toBe(2);
    check.close();
  });

  /**
   * @case The store refuses a deferral database instead of reporting a version
   * @preconditions A file opened by the deferral store first, which stamps its own identity and schema version 4
   * @expectedResult AI1012 says the file is not an agent session store and names what it is. Reported in the field from JetBrains: the old message said the file was "newer than this build understands (2)" and told the reader to run a newer build, which no build could ever satisfy because the file belongs to another store
   */
  test("a deferral database is refused as foreign, not as a newer version", async () => {
    const path = join(scratch, "deferrals-as-sessions.db");
    const deferrals = await SqliteDeferralStore.open({ path });
    await deferrals.close();

    const failure = await SqliteSessionStore.open({ path }).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(failure).toBeDefined();
    expect(failure!.message).toContain("is not an agent session store");
    expect(failure!.message).toContain("deferral");
    expect(failure!.message).not.toContain("newer than this build");
    expect(failure!.message).not.toContain("Run the newer Routecraft build");
  });

  /**
   * @case A fresh database is stamped with the session store's identity
   * @preconditions No file at the path
   * @expectedResult application_id carries the session store's tag, so another store opening it later can say whose it is
   */
  test("a fresh database is stamped with the session identity", async () => {
    const path = join(scratch, "stamped.db");
    const store = await SqliteSessionStore.open({ path });
    await store.close();

    const driver = await resolveSqliteDriver("test");
    const check = new driver.Database(path);
    const row = check.prepare("PRAGMA application_id").get() as {
      application_id: number;
    };
    expect(row.application_id).toBe(SQLITE_APPLICATION_IDS.session);
    check.close();
  });

  /**
   * @case A file written before stamping existed is adopted rather than refused
   * @preconditions A version 1 file carrying agent_sessions and application_id 0, which is every database the published canary wrote
   * @expectedResult It migrates and is stamped, so the identity check never strands a file this store really does own
   */
  test("an unstamped file carrying our own table is adopted", async () => {
    const path = join(scratch, "legacy-unstamped.db");
    const driver = await resolveSqliteDriver("test");
    const seed = new driver.Database(path);
    seed.exec(`CREATE TABLE agent_sessions (
       agent      TEXT    NOT NULL,
       session    TEXT    NOT NULL,
       version    INTEGER NOT NULL,
       record     TEXT    NOT NULL,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (agent, session)
     );`);
    seed.exec("PRAGMA user_version = 1");
    seed.close();

    const store = await SqliteSessionStore.open({ path });
    expect(await store.create(key, { kind: "agent-session" })).toEqual({
      won: true,
    });
    await store.close();

    const check = new driver.Database(path);
    expect(
      (
        check.prepare("PRAGMA application_id").get() as {
          application_id: number;
        }
      ).application_id,
    ).toBe(SQLITE_APPLICATION_IDS.session);
    check.close();
  });

  /**
   * @case An unstamped file holding a foreign schema is refused
   * @preconditions A file with somebody else's table and a non-zero user_version, and no identity stamp
   * @expectedResult Refused as foreign and the message lists the tables it actually holds, which is what an operator sees running sqlite3 against it
   */
  test("an unstamped file holding a foreign schema is refused", async () => {
    const path = join(scratch, "legacy-foreign.db");
    const driver = await resolveSqliteDriver("test");
    const seed = new driver.Database(path);
    seed.exec("CREATE TABLE somebody_elses (id TEXT PRIMARY KEY)");
    seed.exec("PRAGMA user_version = 3");
    seed.close();

    const failure = await SqliteSessionStore.open({ path }).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(failure).toBeDefined();
    expect(failure!.message).toContain("is not an agent session store");
    expect(failure!.message).toContain("somebody_elses");
  });

  /**
   * @case Two stores configured onto one file are refused at resolution
   * @preconditions A context whose deferral store already claimed a path, then sessions: { store } pointed at the same path
   * @expectedResult AI1012 names both settings and the shared path. Reported in the field: both were configured onto .routecraft/sessions.db, nothing objected, and the failure surfaced later inside the ACP auth loop as a schema version the build did not understand
   */
  test("two stores on one path are refused, naming both settings", async () => {
    const path = join(scratch, "shared-by-two.db");
    t = await testContext()
      .with({ deferral: { store: { path } } })
      .build();

    const failure = await createSessionStore(t.ctx, {
      store: { path },
    }).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(failure).toBeDefined();
    expect(failure!.message).toContain("sessions: { store }");
    expect(failure!.message).toContain("deferral: { store }");
    expect(failure!.message).toContain(path);
    expect(failure).toMatchObject({ rc: "AI1012" });
  });

  /**
   * @case A foreign file whose only schema object is a view is refused, not claimed
   * @preconditions An unstamped file at a migratable version holding a view and no tables
   * @expectedResult Refused as foreign, and the file is left untouched with application_id still 0. Deciding emptiness over tables alone read a view-only file as unused, stamped it, and created agent_sessions inside somebody else's database
   */
  test("a file holding only a view is not mistaken for an empty one", async () => {
    const path = join(scratch, "view-only.db");
    const driver = await resolveSqliteDriver("test");
    const seed = new driver.Database(path);
    seed.exec("CREATE TABLE base (id TEXT PRIMARY KEY)");
    seed.exec("CREATE VIEW somebody_elses_view AS SELECT id FROM base");
    seed.exec("DROP TABLE base");
    seed.close();

    const failure = await SqliteSessionStore.open({ path }).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(failure).toBeDefined();
    expect(failure!.message).toContain("is not an agent session store");

    const check = new driver.Database(path);
    expect(
      (
        check.prepare("PRAGMA application_id").get() as {
          application_id: number;
        }
      ).application_id,
    ).toBe(0);
    expect(
      check
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all(),
    ).toEqual([]);
    check.close();
  });

  /**
   * @case A path a replaced store gave up stops blocking another store
   * @preconditions The unconfigured default resolves and claims the default path, then a sessions block replaces it with a different path
   * @expectedResult The default path is free for the deferral store to claim. Holding the released path refused a valid configuration, because agentPlugin resolves a default that sessionsPlugin then closes and replaces
   */
  test("replacing the session store releases the path it gave up", async () => {
    t = await testContext().build();
    await createSessionStore(t.ctx, {}, false);
    const explicit = await createSessionStore(t.ctx, {
      store: { path: join(scratch, "moved-elsewhere.db") },
    });
    await explicit.close();

    expect(() =>
      claimDatabasePath({
        scope: t!.ctx,
        path: DEFAULT_SESSION_DB_PATH,
        claimant: "deferral: { store }",
        onConflict: (conflict) =>
          new Error(`refused, held by ${conflict.held}`),
      }),
    ).not.toThrow();
  });

  /**
   * @case A refused claim leaves the claimant holding what it already had
   * @preconditions One claimant holding a path, then failing to claim a second one another claimant owns
   * @expectedResult The first path is still held, so releasing on replacement never drops a claim on a claim that did not succeed
   */
  test("a refused claim does not release the path already held", () => {
    const scope = {};
    const first = join(scratch, "held-first.db");
    const taken = join(scratch, "taken-by-other.db");
    claimDatabasePath({
      scope,
      path: first,
      claimant: "sessions: { store }",
      onConflict: () => new Error("unexpected"),
    });
    claimDatabasePath({
      scope,
      path: taken,
      claimant: "deferral: { store }",
      onConflict: () => new Error("unexpected"),
    });
    expect(() =>
      claimDatabasePath({
        scope,
        path: taken,
        claimant: "sessions: { store }",
        onConflict: () => new Error("refused"),
      }),
    ).toThrow("refused");
    expect(() =>
      claimDatabasePath({
        scope,
        path: first,
        claimant: "deferral: { store }",
        onConflict: () => new Error("still held"),
      }),
    ).toThrow("still held");
  });

  /**
   * @case A store replaced by the memory backend gives up the path it held
   * @preconditions The unconfigured default claims the default path, then a sessions block chooses "memory"
   * @expectedResult The default path is free. The release only fired when the replacement claimed another file, so a replacement with no file at all left the path held and refused the next store to want it
   */
  test("replacing the store with memory releases the path", async () => {
    t = await testContext().build();
    await createSessionStore(t.ctx, {}, false);
    await createSessionStore(t.ctx, { store: "memory" });

    expect(() =>
      claimDatabasePath({
        scope: t!.ctx,
        path: DEFAULT_SESSION_DB_PATH,
        claimant: "deferral: { store }",
        onConflict: (conflict) =>
          new Error(`refused, held by ${conflict.held}`),
      }),
    ).not.toThrow();
  });

  /**
   * @case A store replaced by a caller's own backend gives up the path it held
   * @preconditions The unconfigured default claims the default path, then a sessions block supplies a SessionStore instance
   * @expectedResult The default path is free. A supplied backend never reaches the claim at all, so nothing released what the default had taken
   */
  test("replacing the store with a supplied backend releases the path", async () => {
    t = await testContext().build();
    await createSessionStore(t.ctx, {}, false);
    await createSessionStore(t.ctx, { store: new MemorySessionStore() });

    expect(() =>
      claimDatabasePath({
        scope: t!.ctx,
        path: DEFAULT_SESSION_DB_PATH,
        claimant: "deferral: { store }",
        onConflict: (conflict) =>
          new Error(`refused, held by ${conflict.held}`),
      }),
    ).not.toThrow();
  });

  /**
   * @case Claiming ":memory:" gives up the file the claimant held
   * @preconditions One claimant holding a file path, then claiming ":memory:"
   * @expectedResult The file is free for another claimant. ":memory:" returned before the release ran, so a store moving to an in-process database kept blocking the file it had left
   */
  test("claiming :memory: releases the file the claimant held", () => {
    const scope = {};
    const file = join(scratch, "left-behind.db");
    claimDatabasePath({
      scope,
      path: file,
      claimant: "sessions: { store }",
      onConflict: () => new Error("unexpected"),
    });
    claimDatabasePath({
      scope,
      path: ":memory:",
      claimant: "sessions: { store }",
      onConflict: () => new Error("unexpected"),
    });

    expect(() =>
      claimDatabasePath({
        scope,
        path: file,
        claimant: "deferral: { store }",
        onConflict: (conflict) =>
          new Error(`refused, held by ${conflict.held}`),
      }),
    ).not.toThrow();
  });
});
