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
    const result = await connectCommand("demo", { open: false });
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
    await connectCommand("demo", { open: false });
    const after = await connectCommand(undefined, { list: true });
    expect(after.output).toContain("demo  https://demo.test/mcp  connected");
  });

  /**
   * @case --all skips a client that already holds a credential
   * @preconditions demo already connected
   * @expectedResult Exit 0 with nothing to do
   */
  test("--all skips what is already held", async () => {
    await connectCommand("demo", { open: false });
    const result = await connectCommand(undefined, { all: true, open: false });
    expect(result).toMatchObject({
      code: 0,
      output: "Every client already holds a credential.",
    });
  });

  /**
   * @case --export without a key
   * @preconditions ROUTECRAFT_CREDENTIALS_KEY unset
   * @expectedResult Exit 1 naming the variable, before any login runs
   */
  test("--export refuses without a key", async () => {
    const result = await connectCommand("demo", { export: true, open: false });
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
    process.env[core.CREDENTIALS_KEY_ENV] = "test-key";
    const result = await connectCommand("demo", { export: true, open: false });
    expect(result.code).toBe(0);
    const entries = core.decodeCredentialSeed(
      result.output!,
      core.createSealer("test-key"),
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
    await connectCommand("demo", { open: false });
    expect((await disconnectCommand("demo")).code).toBe(0);
    expect(await stored()).toBeUndefined();
    expect((await disconnectCommand("demo")).output).toContain(
      "held no credential",
    );
  });

  /**
   * @case An unknown client name
   * @preconditions Only demo is declared
   * @expectedResult Exit 1 naming the clients that do log in
   */
  test("names the known clients for an unknown one", async () => {
    const result = await connectCommand("nope", { open: false });
    expect(result.code).toBe(1);
    expect(result.error).toContain("Those that do: demo.");
  });
});
