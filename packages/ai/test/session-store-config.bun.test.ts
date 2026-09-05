import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySuspensionStore,
  type SqliteDriverLoaders,
} from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { agentPlugin, llmPlugin } from "../src/index.ts";
import {
  AgentSessionRuntime,
  MemorySessionStore,
  SESSION_STORE_ENV,
  SqliteSessionStore,
} from "../src/agent/session/index.ts";
import {
  createSessionStore,
  DeferredSqliteSessionStore,
} from "../src/agent/session/config.ts";
import { ADAPTER_AGENT_SESSION_STORE } from "../src/agent/store.ts";
import { MODEL } from "./helpers/suspend-fixtures.ts";

const scratch = mkdtempSync(join(tmpdir(), "rc-sessions-config-"));
const key = { agent: "max", session: "s" };

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
    expect(resolved.store).toBeInstanceOf(DeferredSqliteSessionStore);
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
    const store = new DeferredSqliteSessionStore(path);
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
        suspension: { store: new MemorySuspensionStore() },
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
      .with({ suspension: { store: new MemorySuspensionStore() } })
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
   * @preconditions A context with a suspension block and no session-owning plugin, read before any session work
   * @expectedResult The resolved store reports the unresolved backend rather than guessing sqlite
   */
  test("the inline fallback reports no backend before it resolves", async () => {
    t = await testContext()
      .with({ suspension: { store: new MemorySuspensionStore() } })
      .build();
    AgentSessionRuntime.for(t.ctx);
    expect(t.ctx.getStore(ADAPTER_AGENT_SESSION_STORE)?.backend).toBe(
      "unresolved",
    );
  });

  /**
   * @case An inline session with no session-owning plugin resolves its store the way the plugins do, environment included
   * @preconditions A context with a suspension block and neither agentPlugin() nor a sessions key; ROUTECRAFT_SESSION_STORE=memory; the runtime is created for the context and used once
   * @expectedResult The context's resolved store reports the memory backend after that use and is unconfigured
   */
  test("the inline fallback resolves like the plugins", async () => {
    process.env[SESSION_STORE_ENV] = "memory";
    t = await testContext()
      .with({ suspension: { store: new MemorySuspensionStore() } })
      .build();
    const runtime = AgentSessionRuntime.for(t.ctx);
    expect(await runtime.store.list()).toEqual([]);
    const resolved = t.ctx.getStore(ADAPTER_AGENT_SESSION_STORE);
    expect(resolved?.backend).toBe("memory");
    expect(resolved?.configured).toBe(false);
  });

  /**
   * @case The inline fallback refuses work once the context has stopped, rather than reopening a store it released
   * @preconditions A context with a suspension block and no session-owning plugin; the runtime is created, the context is stopped, and a session read is attempted afterwards
   * @expectedResult The read rejects with AI1012 naming a call after teardown
   */
  test("the inline fallback stays closed after the context stops", async () => {
    process.env[SESSION_STORE_ENV] = "memory";
    const ctx = await testContext()
      .with({ suspension: { store: new MemorySuspensionStore() } })
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
    expect(resolved?.store).toBeInstanceOf(DeferredSqliteSessionStore);
  });
});
