import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { connectCommand, disconnectCommand } = await import("../src/connect");
const core = await import("@routecraft/routecraft");

const REGISTRY_KEY = Symbol.for("routecraft.credential-login-collectors");
type Registry = Map<string, unknown>;
const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };

/**
 * A project whose config declares one login, `demo`, without any protocol:
 * it plays the browser by requesting the loopback redirect itself, and
 * stores what came back. That drives the CLI's listener end to end.
 */
const CONFIG = (dbPath: string) => `
import { registerCredentialLogins } from "@routecraft/routecraft";

registerCredentialLogins("test-connect", () => [
  {
    id: "demo",
    owner: "test:demo",
    description: "https://demo.test/mcp",
    async login(store, io) {
      await io.openUrl(new URL("https://as.test/authorize"));
      // A request without an authorization response must not end the wait.
      const stray = await fetch(io.redirectUrl);
      if (stray.status !== 400) throw new Error("a stray request settled the login");
      void fetch(io.redirectUrl + "?code=c-1&state=s-1");
      const back = await io.waitForCallback();
      const current = await store.get("test:demo");
      await store.put("test:demo", { code: back.get("code") }, {
        ifVersion: current?.version ?? null,
        issuedAt: Date.now(),
      });
    },
  },
]);

export const craftConfig = { credentials: { store: ${JSON.stringify(dbPath)} } };
`;

/** Swallows the login instructions instead of touching process.stderr. */
const quiet = (): void => undefined;

describe("craft connect", () => {
  let root: string;
  let cwd: string;
  let saved: Registry | undefined;
  let savedKey: string | undefined;
  let counter = 0;

  beforeEach(() => {
    counter += 1;
    root = join(import.meta.dir, `tmp-connect-${Date.now()}-${counter}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "craft.config.ts"),
      CONFIG(join(root, "creds.db")),
    );
    cwd = process.cwd();
    process.chdir(root);
    saved = new Map(g[REGISTRY_KEY] ?? []);
    savedKey = process.env[core.CREDENTIALS_KEY_ENV];
    delete process.env[core.CREDENTIALS_KEY_ENV];
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
    g[REGISTRY_KEY] = saved ?? new Map();
    if (savedKey === undefined) delete process.env[core.CREDENTIALS_KEY_ENV];
    else process.env[core.CREDENTIALS_KEY_ENV] = savedKey;
  });

  async function stored(): Promise<unknown> {
    const store = await core.SqliteCredentialStore.open({
      path: join(root, "creds.db"),
    });
    try {
      return (await store.get("test:demo"))?.value;
    } finally {
      await store.close();
    }
  }

  /**
   * @case Logging a client in through the loopback listener
   * @preconditions A config declaring the login "demo"; the browser is not opened
   * @expectedResult Exit 0, and the store at the configured path holds what the redirect carried
   */
  test("logs a client in and stores the credential", async () => {
    const result = await connectCommand("demo", { open: false, stderr: quiet });
    expect(result).toMatchObject({ code: 0, output: 'Connected "demo".' });
    expect(await stored()).toEqual({ code: "c-1" });
  });

  /**
   * @case Listing before and after a login
   * @preconditions The login "demo", not yet run, then run
   * @expectedResult The list says not connected with the command to run, then connected
   */
  test("lists what each client holds", async () => {
    const before = await connectCommand(undefined, { list: true });
    expect(before.output).toContain("not connected; run `craft connect demo`");
    await connectCommand("demo", { open: false, stderr: quiet });
    const after = await connectCommand(undefined, { list: true });
    expect(after.output).toContain("demo  https://demo.test/mcp  connected");
  });

  /**
   * @case --all skips a client that already holds a credential
   * @preconditions demo already connected
   * @expectedResult Exit 0 with nothing to do
   */
  test("--all skips what is already held", async () => {
    await connectCommand("demo", { open: false, stderr: quiet });
    const result = await connectCommand(undefined, {
      all: true,
      open: false,
      stderr: quiet,
    });
    expect(result).toMatchObject({
      code: 0,
      output: "Every client already holds a credential.",
    });
  });

  /**
   * @case --all logs in a client that holds nothing
   * @preconditions demo not yet connected
   * @expectedResult Exit 0 reporting demo connected, and the store holds its credential
   */
  test("--all logs in what holds nothing", async () => {
    const result = await connectCommand(undefined, {
      all: true,
      open: false,
      stderr: quiet,
    });
    expect(result).toMatchObject({ code: 0, output: 'Connected "demo".' });
    expect(await stored()).toEqual({ code: "c-1" });
  });

  /**
   * @case Naming a client that is already connected
   * @preconditions demo connected once
   * @expectedResult A second craft connect demo logs in again and replaces the credential
   */
  test("a named client is logged in again", async () => {
    await connectCommand("demo", { open: false, stderr: quiet });
    const again = await connectCommand("demo", { open: false, stderr: quiet });
    expect(again).toMatchObject({ code: 0, output: 'Connected "demo".' });
    const store = await core.SqliteCredentialStore.open({
      path: join(root, "creds.db"),
    });
    try {
      expect((await store.get("test:demo"))?.version).toBe(2);
    } finally {
      await store.close();
    }
  });

  /**
   * @case craft connect with neither a client nor --all
   * @preconditions demo declared, not connected
   * @expectedResult Exit 1 asking for a client or --all, and nothing is logged in
   */
  test("needs a client or --all", async () => {
    const result = await connectCommand(undefined, {
      open: false,
      stderr: quiet,
    });
    expect(result.code).toBe(1);
    expect(result.error).toContain("--all");
    expect(await stored()).toBeUndefined();
  });

  /**
   * @case A credential whose client is no longer declared
   * @preconditions The store holds test:gone, which no login claims
   * @expectedResult --list names it with the command to remove it, and craft disconnect test:gone removes it
   */
  test("lists and removes a credential no client claims", async () => {
    const store = await core.SqliteCredentialStore.open({
      path: join(root, "creds.db"),
    });
    try {
      await store.put("test:gone", { code: "old" }, { ifVersion: null });
    } finally {
      await store.close();
    }
    const listed = await connectCommand(undefined, { list: true });
    expect(listed.output).toContain(
      "test:gone  no longer declared; remove with `craft disconnect test:gone`",
    );
    expect((await disconnectCommand("test:gone")).code).toBe(0);
    const after = await connectCommand(undefined, { list: true });
    expect(after.output).not.toContain("test:gone");
  });

  /**
   * @case --export without a key
   * @preconditions ROUTECRAFT_CREDENTIALS_KEY unset
   * @expectedResult Exit 1 naming the variable, before any login runs
   */
  test("--export refuses without a key", async () => {
    const result = await connectCommand("demo", {
      export: true,
      open: false,
      stderr: quiet,
    });
    expect(result.code).toBe(1);
    expect(result.error).toContain(core.CREDENTIALS_KEY_ENV);
    expect(await stored()).toBeUndefined();
  });

  /**
   * @case --export with a key prints a seed a server can import
   * @preconditions A key set; demo not yet connected
   * @expectedResult demo is logged in, and the printed seed decodes under the key to its credential
   */
  test("--export prints a sealed seed", async () => {
    process.env[core.CREDENTIALS_KEY_ENV] =
      "test-key-0123456789abcdef0123456789abcdef";
    const result = await connectCommand("demo", {
      export: true,
      open: false,
      stderr: quiet,
    });
    expect(result.code).toBe(0);
    const entries = core.decodeCredentialSeed(
      result.output!,
      core.createSealer("test-key-0123456789abcdef0123456789abcdef"),
    );
    expect(entries).toMatchObject([
      { owner: "test:demo", value: { code: "c-1" } },
    ]);
  });

  /**
   * @case Disconnecting removes the credential
   * @preconditions demo connected
   * @expectedResult Exit 0, the store no longer holds it, and a second disconnect says nothing was held
   */
  test("disconnect removes the credential", async () => {
    await connectCommand("demo", { open: false, stderr: quiet });
    expect((await disconnectCommand("demo")).code).toBe(0);
    expect(await stored()).toBeUndefined();
    expect((await disconnectCommand("demo")).output).toContain(
      "held no credential",
    );
  });

  /**
   * @case A project whose credential store is memory
   * @preconditions credentials.store set to "memory"
   * @expectedResult Exit 1 saying a login there cannot reach the application, and no login runs
   */
  test("refuses a memory store", async () => {
    writeFileSync(
      join(root, "craft.config.ts"),
      CONFIG(join(root, "creds.db")).replace(
        /export const craftConfig = .*/,
        'export const craftConfig = { credentials: { store: "memory" } };',
      ),
    );
    const result = await connectCommand("demo", { open: false, stderr: quiet });
    expect(result.code).toBe(1);
    expect(result.error).toContain("configured as memory");
  });

  /**
   * @case An unknown client name
   * @preconditions Only demo is declared
   * @expectedResult Exit 1 naming the clients that do log in
   */
  test("names the known clients for an unknown one", async () => {
    const result = await connectCommand("nope", { open: false, stderr: quiet });
    expect(result.code).toBe(1);
    expect(result.error).toContain("Those that do: demo.");
  });
});
