import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testContext } from "@routecraft/testing";
import {
  CREDENTIALS,
  craft,
  credentialsConfigOf,
  credentialsPlugin,
  definePlugin,
  direct,
  noop,
  collectCredentialLogins,
  createSealer,
  decodeCredentialSeed,
  encodeCredentialSeed,
  importCredentialSeed,
  MemoryCredentialStore,
  openCredentialStore,
  registerCredentialLogins,
  SqliteCredentialStore,
  type CredentialStore,
} from "../src/index.ts";
import { SQLITE_APPLICATION_IDS } from "../src/shared/sqlite/database.ts";
import { rcError } from "../src/error.ts";

const scratch = mkdtempSync(join(tmpdir(), "rc-credentials-"));
let files = 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function dbPath(): string {
  files += 1;
  return join(scratch, `credentials-${files}.db`);
}

const backends: Array<[string, () => Promise<CredentialStore>]> = [
  ["memory", async () => new MemoryCredentialStore()],
  ["sqlite", () => SqliteCredentialStore.open({ path: dbPath() })],
];

describe.each(backends)("credential store (%s)", (_name, open) => {
  /**
   * @case A first write creates the record at version 1
   * @preconditions An empty store
   * @expectedResult The write lands at version 1 and reads back with its value and issue time
   */
  test("creates at version 1", async () => {
    const store = await open();
    const write = await store.put(
      "mcp:mail",
      { tokens: { access_token: "a" } },
      {
        ifVersion: null,
        issuedAt: 1_000,
      },
    );
    expect(write).toEqual({ written: true, version: 1 });
    const stored = await store.get("mcp:mail");
    expect(stored).toMatchObject({
      value: { tokens: { access_token: "a" } },
      version: 1,
      issuedAt: 1_000,
    });
    await store.close();
  });

  /**
   * @case A write against a stale version is refused and reports the current record
   * @preconditions A record at version 2, written by another process after this one read version 1
   * @expectedResult The stale write is not applied; the result carries version 2 and its value
   */
  test("refuses a write against a stale version", async () => {
    const store = await open();
    await store.put("mcp:mail", { n: 1 }, { ifVersion: null });
    await store.put("mcp:mail", { n: 2 }, { ifVersion: 1 });
    const stale = await store.put("mcp:mail", { n: 3 }, { ifVersion: 1 });
    expect(stale.written).toBe(false);
    expect(stale.written ? undefined : stale.current).toMatchObject({
      value: { n: 2 },
      version: 2,
    });
    expect((await store.get("mcp:mail"))?.value).toEqual({ n: 2 });
    await store.close();
  });

  /**
   * @case A create races an existing record
   * @preconditions A record exists; a second writer believes there is none (ifVersion null)
   * @expectedResult The create is refused and the existing record stays
   */
  test("refuses a create over an existing record", async () => {
    const store = await open();
    await store.put("mcp:mail", { first: true }, { ifVersion: null });
    const second = await store.put(
      "mcp:mail",
      { first: false },
      {
        ifVersion: null,
      },
    );
    expect(second.written).toBe(false);
    expect((await store.get("mcp:mail"))?.value).toEqual({ first: true });
    await store.close();
  });

  /**
   * @case An update without issuedAt keeps the record's issue time
   * @preconditions A record issued at 1000, refreshed without an issue time
   * @expectedResult issuedAt stays 1000 while the version advances
   */
  test("a refresh keeps the issue time", async () => {
    const store = await open();
    await store.put("mcp:mail", { n: 1 }, { ifVersion: null, issuedAt: 1_000 });
    await store.put("mcp:mail", { n: 2 }, { ifVersion: 1 });
    expect(await store.get("mcp:mail")).toMatchObject({
      version: 2,
      issuedAt: 1_000,
    });
    await store.close();
  });

  /**
   * @case A conditional delete only removes the version it names
   * @preconditions A record at version 2
   * @expectedResult A delete at version 1 removes nothing; one at version 2 removes the record
   */
  test("deletes only the version it names", async () => {
    const store = await open();
    await store.put("mcp:mail", { n: 1 }, { ifVersion: null });
    await store.put("mcp:mail", { n: 2 }, { ifVersion: 1 });
    expect(await store.delete("mcp:mail", { ifVersion: 1 })).toBe(false);
    expect(await store.get("mcp:mail")).toBeDefined();
    expect(await store.delete("mcp:mail", { ifVersion: 2 })).toBe(true);
    expect(await store.get("mcp:mail")).toBeUndefined();
    await store.close();
  });

  /**
   * @case Listing returns every owner
   * @preconditions Two records
   * @expectedResult Both owners are listed, in owner order
   */
  test("lists every owner", async () => {
    const store = await open();
    await store.put("mcp:b", 1, { ifVersion: null });
    await store.put("mcp:a", 2, { ifVersion: null });
    expect((await store.list()).map((each) => each.owner)).toEqual([
      "mcp:a",
      "mcp:b",
    ]);
    await store.close();
  });
});

describe("sqlite credential store at rest", () => {
  /**
   * @case The database file is readable by its owner only
   * @preconditions A store opened at a fresh path
   * @expectedResult The file mode is 0600
   */
  test("creates the file owner-only", async () => {
    const path = dbPath();
    const store = await SqliteCredentialStore.open({ path });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await store.close();
  });

  /**
   * @case A sealed store keeps no plaintext on disk
   * @preconditions A store opened with a sealer, holding a refresh token
   * @expectedResult The file does not contain the token, and the store reads it back
   */
  test("seals values with a key", async () => {
    const path = dbPath();
    const store = await SqliteCredentialStore.open({
      path,
      sealer: createSealer("key-one-0123456789abcdef0123456789abcdef"),
    });
    await store.put(
      "mcp:mail",
      { refresh_token: "very-secret-refresh" },
      {
        ifVersion: null,
      },
    );
    await store.close();
    expect(readFileSync(path).includes("very-secret-refresh")).toBe(false);
    const reopened = await SqliteCredentialStore.open({
      path,
      sealer: createSealer("key-one-0123456789abcdef0123456789abcdef"),
    });
    expect((await reopened.get("mcp:mail"))?.value).toEqual({
      refresh_token: "very-secret-refresh",
    });
    await reopened.close();
  });

  /**
   * @case A sealed value read without the key, or under another key
   * @preconditions A record sealed under key-one
   * @expectedResult Both reads fail with RC5070
   */
  test("refuses a sealed value without its key", async () => {
    const path = dbPath();
    const store = await SqliteCredentialStore.open({
      path,
      sealer: createSealer("key-one-0123456789abcdef0123456789abcdef"),
    });
    await store.put("mcp:mail", { a: 1 }, { ifVersion: null });
    await store.close();
    const keyless = await SqliteCredentialStore.open({ path });
    await expect(keyless.get("mcp:mail")).rejects.toMatchObject({
      rc: "RC5070",
    });
    await keyless.close();
    const wrong = await SqliteCredentialStore.open({
      path,
      sealer: createSealer("key-two-0123456789abcdef0123456789abcdef"),
    });
    await expect(wrong.get("mcp:mail")).rejects.toMatchObject({ rc: "RC5070" });
    await wrong.close();
  });

  /**
   * @case Opening another store's database file as the credential store
   * @preconditions A file stamped as the deferral store
   * @expectedResult The open fails with RC5070 naming the owning store
   */
  test("refuses another store's file", async () => {
    const path = dbPath();
    const { Database } = await import("bun:sqlite");
    const other = new Database(path);
    other.exec(`PRAGMA application_id = ${SQLITE_APPLICATION_IDS.deferral}`);
    other.exec("CREATE TABLE deferrals (id TEXT PRIMARY KEY)");
    other.close();
    await expect(SqliteCredentialStore.open({ path })).rejects.toMatchObject({
      rc: "RC5070",
      message: expect.stringContaining("deferral"),
    });
  });
});

describe("openCredentialStore", () => {
  /**
   * @case The store named by ROUTECRAFT_CREDENTIALS_STORE
   * @preconditions The environment names "memory"; no store is configured
   * @expectedResult A memory store the caller owns
   */
  test("honours the environment variable", async () => {
    const opened = await openCredentialStore({
      env: { ROUTECRAFT_CREDENTIALS_STORE: "memory" },
    });
    expect(opened.backend).toBe("memory");
    expect(opened.owned).toBe(true);
  });

  /**
   * @case A store object passed as configuration
   * @preconditions credentials.store is a CredentialStore instance
   * @expectedResult That instance is returned, not owned by the caller
   */
  test("passes a custom store through", async () => {
    const store = new MemoryCredentialStore();
    const opened = await openCredentialStore({ store, env: {} });
    expect(opened).toMatchObject({ store, owned: false, backend: "custom" });
  });
});

describe("credential seed", () => {
  const sealer = createSealer("seed-key-0123456789abcdef0123456789abcdef");

  /**
   * @case A seed round-trips under its key
   * @preconditions One entry encoded with a sealer
   * @expectedResult Decoding with the same key returns the entry; the seed text does not contain the value
   */
  test("round-trips", () => {
    const seed = encodeCredentialSeed(
      [{ owner: "mcp:mail", value: { refresh_token: "r1" }, issuedAt: 5 }],
      sealer,
    );
    expect(seed.startsWith("rcseed1.")).toBe(true);
    expect(seed.includes("r1")).toBe(false);
    expect(decodeCredentialSeed(seed, sealer)).toEqual([
      { owner: "mcp:mail", value: { refresh_token: "r1" }, issuedAt: 5 },
    ]);
  });

  /**
   * @case A seed decoded without a key, with another key, or malformed
   * @preconditions A valid seed, and a string that is not one
   * @expectedResult Each decode fails with RC5070
   */
  test("refuses without the right key", () => {
    const seed = encodeCredentialSeed([], sealer);
    expect(() => decodeCredentialSeed(seed, undefined)).toThrow(
      expect.objectContaining({ rc: "RC5070" }),
    );
    expect(() =>
      decodeCredentialSeed(
        seed,
        createSealer("other-0123456789abcdef0123456789abcdef"),
      ),
    ).toThrow(expect.objectContaining({ rc: "RC5070" }));
    expect(() => decodeCredentialSeed("not-a-seed", sealer)).toThrow(
      expect.objectContaining({ rc: "RC5070" }),
    );
  });

  /**
   * @case A seed that opens under its key but carries bad content
   * @preconditions One sealed payload that is not JSON; one whose second entry has no value
   * @expectedResult Both fail with RC5070 rather than importing part of the seed
   */
  test("refuses a damaged payload whole", () => {
    const garbage = `rcseed1.${sealer.seal("{not json", "seed")}`;
    expect(() => decodeCredentialSeed(garbage, sealer)).toThrow(
      expect.objectContaining({ rc: "RC5070" }),
    );
    const partial = `rcseed1.${sealer.seal(
      JSON.stringify({
        v: 1,
        entries: [
          { owner: "mcp:a", value: 1, issuedAt: 1 },
          { owner: "mcp:b", issuedAt: 1 },
        ],
      }),
      "seed",
    )}`;
    expect(() => decodeCredentialSeed(partial, sealer)).toThrow(
      expect.objectContaining({ rc: "RC5070" }),
    );
  });

  /**
   * @case A key too short to seal with
   * @preconditions A 16-character key
   * @expectedResult createSealer throws RC5070 naming the minimum
   */
  test("refuses a short key", () => {
    expect(() => createSealer("0123456789abcdef")).toThrow(
      expect.objectContaining({ rc: "RC5070" }),
    );
  });

  /**
   * @case Importing a seed over an empty store, a newer record, and an older one
   * @preconditions mcp:a absent; mcp:b refreshed after a login newer than the seed; mcp:c from an older login
   * @expectedResult mcp:a and mcp:c are imported; mcp:b keeps its refreshed value
   */
  test("imports only what is newer than the store", async () => {
    const store = new MemoryCredentialStore();
    await store.put("mcp:b", "refreshed", { ifVersion: null, issuedAt: 200 });
    await store.put("mcp:c", "old", { ifVersion: null, issuedAt: 50 });
    const result = await importCredentialSeed(store, [
      { owner: "mcp:a", value: "seeded-a", issuedAt: 100 },
      { owner: "mcp:b", value: "seeded-b", issuedAt: 100 },
      { owner: "mcp:c", value: "seeded-c", issuedAt: 100 },
    ]);
    expect(result).toEqual({ imported: ["mcp:a", "mcp:c"], kept: ["mcp:b"] });
    expect((await store.get("mcp:b"))?.value).toBe("refreshed");
    expect(await store.get("mcp:c")).toMatchObject({
      value: "seeded-c",
      issuedAt: 100,
    });
  });

  /**
   * @case Importing the same seed twice after a refresh
   * @preconditions A seed imported, then the record refreshed (issuedAt unchanged)
   * @expectedResult The second import keeps the refreshed record
   */
  test("never imports the same seed over a refresh", async () => {
    const store = new MemoryCredentialStore();
    const entries = [{ owner: "mcp:a", value: "seeded", issuedAt: 100 }];
    await importCredentialSeed(store, entries);
    await store.put("mcp:a", "refreshed", { ifVersion: 1 });
    expect(await importCredentialSeed(store, entries)).toEqual({
      imported: [],
      kept: ["mcp:a"],
    });
    expect((await store.get("mcp:a"))?.value).toBe("refreshed");
  });
});

describe("credentials plugin", () => {
  /**
   * @case A seed in the environment is imported as the application binds
   * @preconditions ROUTECRAFT_CREDENTIALS_SEED and ROUTECRAFT_CREDENTIALS_KEY set; an empty store
   * @expectedResult The store behind the CREDENTIALS port holds the seeded credential once the context is built
   */
  test("imports the seed at bind", async () => {
    const sealer = createSealer("boot-key-0123456789abcdef0123456789abcdef");
    const seed = encodeCredentialSeed(
      [{ owner: "mcp:mail", value: { refresh_token: "r1" }, issuedAt: 7 }],
      sealer,
    );
    const store = new MemoryCredentialStore();
    const t = await testContext()
      .with({
        plugins: [
          credentialsPlugin({
            store,
            env: {
              ROUTECRAFT_CREDENTIALS_SEED: seed,
              ROUTECRAFT_CREDENTIALS_KEY:
                "boot-key-0123456789abcdef0123456789abcdef",
            },
          }),
        ],
      })
      .routes([craft().id("idle").from(direct()).to(noop())])
      .build();
    try {
      const provided = t.ctx.lookup(CREDENTIALS);
      expect(await provided?.get("mcp:mail")).toMatchObject({
        value: { refresh_token: "r1" },
        issuedAt: 7,
      });
    } finally {
      await t.stop();
    }
  });
});

describe("credential store fallback and resolution", () => {
  /** Loaders that fail as Node does without better-sqlite3. */
  const absentDriver = {
    bun: () => Promise.reject(rcError("RC5017")),
    node: () => Promise.reject(rcError("RC5017")),
  };

  async function bound(config: Parameters<typeof credentialsPlugin>[0]) {
    const t = await testContext()
      .with({ plugins: [credentialsPlugin(config)] })
      .routes([craft().id("idle").from(direct()).to(noop())])
      .build();
    return { t, store: t.ctx.lookup(CREDENTIALS)! };
  }

  /**
   * @case The default store with no SQLite driver available
   * @preconditions No store configured; both driver loaders fail
   * @expectedResult The store falls back to memory and still reads and writes
   */
  test("the unconfigured store falls back to memory", async () => {
    const { t, store } = await bound({ loaders: absentDriver, env: {} });
    try {
      await store.put("mcp:a", 1, { ifVersion: null });
      expect((await store.get("mcp:a"))?.value).toBe(1);
    } finally {
      await t.stop();
    }
  });

  /**
   * @case A configured store path with no SQLite driver available
   * @preconditions credentials.store names a path; both driver loaders fail
   * @expectedResult The first read fails rather than silently keeping credentials in memory
   */
  test("a configured store does not fall back", async () => {
    const { t, store } = await bound({
      store: dbPath(),
      loaders: absentDriver,
      env: {},
    });
    try {
      await expect(store.get("mcp:a")).rejects.toThrow();
    } finally {
      await t.stop();
    }
  });

  /**
   * @case Which store configuration craft connect opens
   * @preconditions A credentials key, a credentialsPlugin() in plugins, and a foreign plugin providing the port
   * @expectedResult The key is used alone; a credentialsPlugin()'s own config wins over it, also when spread or brought by another plugin's installs; a foreign provider is refused with RC5070
   */
  test("credentialsConfigOf follows what the application uses", () => {
    expect(credentialsConfigOf({ credentials: { store: "a.db" } })).toEqual({
      store: "a.db",
    });
    const plugin = credentialsPlugin({ store: "b.db" });
    expect(
      credentialsConfigOf({
        credentials: { store: "a.db" },
        plugins: [plugin],
      }),
    ).toEqual({ store: "b.db" });
    expect(credentialsConfigOf({ plugins: [{ ...plugin }] })).toEqual({
      store: "b.db",
    });
    const bundle = definePlugin({
      id: "acme.bundle",
      installs: [plugin],
      bind() {},
    });
    expect(credentialsConfigOf({ plugins: [bundle] })).toEqual({
      store: "b.db",
    });
    const vault = definePlugin({
      id: "acme.vault",
      provides: [CREDENTIALS],
      bind() {},
    });
    expect(() => credentialsConfigOf({ plugins: [vault] })).toThrow(
      expect.objectContaining({ rc: "RC5070" }),
    );
  });
});

describe("credential logins", () => {
  const REGISTRY_KEY = Symbol.for("routecraft.credential-login-collectors");
  type Registry = Map<string, unknown>;
  const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };

  /**
   * @case Two collectors declaring one login id, or one store owner
   * @preconditions Collectors "x" and "y" each return a login named "mail"; then "y" returns another name kept under x's owner
   * @expectedResult Collecting throws naming the id, then the owner
   */
  test("refuses a duplicate id", () => {
    const saved = new Map(g[REGISTRY_KEY] ?? []);
    try {
      g[REGISTRY_KEY] = new Map();
      const login = {
        id: "mail",
        owner: "x:mail",
        description: "",
        login: async () => undefined,
      };
      registerCredentialLogins("x", () => [login]);
      expect(collectCredentialLogins({})).toHaveLength(1);
      registerCredentialLogins("y", () => [{ ...login, owner: "y:mail" }]);
      expect(() => collectCredentialLogins({})).toThrow(/"mail"/);
      registerCredentialLogins("y", () => [{ ...login, id: "post" }]);
      expect(() => collectCredentialLogins({})).toThrow(/"x:mail"/);
    } finally {
      g[REGISTRY_KEY] = saved;
    }
  });
});
