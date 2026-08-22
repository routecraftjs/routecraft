import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CraftContext,
  MemorySuspensionStore,
  SUSPENSION_SECRET_ENV,
  SUSPENSION_STORE_ENV,
  rcError,
  type SuspensionRuntime,
} from "../src/index.ts";
// Engine machinery, reached through the intra-package barrel.
import { createSuspensionRuntime } from "../src/suspension/index.ts";
import type { SqliteDriverLoaders } from "../src/shared/sqlite/driver.ts";

const scratch = mkdtempSync(join(tmpdir(), "rc-suspension-runtime-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Loaders that behave like a Node process without `better-sqlite3`
 * installed, on whichever runtime the suite happens to run on. Simulating
 * the absent peer beats uninstalling it: the arm under test is the
 * framework's reaction to RC5017, not the module resolver's.
 */
const absentPeerLoaders: SqliteDriverLoaders = {
  bun: () =>
    Promise.reject(
      rcError("RC5017", undefined, { message: "bun:sqlite unavailable" }),
    ),
  node: () =>
    Promise.reject(
      rcError("RC5017", undefined, {
        message:
          'suspension store (sqlite) requires the optional peer dependency "better-sqlite3".',
      }),
    ),
};

// At least 32 bytes: resolveSigningSecret enforces a strength floor.
const SECRET = { secret: "runtime-test-secret-padded-to-32b" };

/**
 * Redirect a context's warn channel into an array of message strings. The
 * message is the second pino argument; the first is the bindings object.
 */
function captureWarnings(context: CraftContext): string[] {
  const messages: string[] = [];
  context.logger.warn = ((...args: unknown[]) => {
    messages.push(String(args[1] ?? ""));
  }) as unknown as typeof context.logger.warn;
  return messages;
}

describe("suspension runtime resolution", () => {
  let runtime: SuspensionRuntime | undefined;
  const inherited: Record<string, string | undefined> = {};

  // Every test here exercises a resolution path that reads the environment,
  // and both variables resolve ahead of the config this suite passes in. A
  // value inherited from the shell or CI would silently change which arm
  // runs: an ambient secret turns the ephemeral-key test into an env-key
  // test, and an ambient store path turns a fallback test into a real store.
  beforeEach(() => {
    for (const key of [SUSPENSION_STORE_ENV, SUSPENSION_SECRET_ENV]) {
      inherited[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    // Same rule the plugin's teardown follows: a store the caller supplied
    // is the caller's to close. Closing it here would contradict the
    // ownership contract this suite asserts a few tests down, and would
    // break the moment a custom backend has a close that does something.
    if (runtime?.ownsStore) await runtime.store.close();
    runtime = undefined;
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /**
   * @case The durable backend is the default, because durability is the
   *   whole feature
   * @preconditions A context configured with a store path and a secret
   * @expectedResult The sqlite backend is selected
   */
  test("defaults to the durable sqlite backend", async () => {
    runtime = await createSuspensionRuntime(new CraftContext(), {
      ...SECRET,
      store: { path: join(scratch, "default.db") },
    });

    expect(runtime.backend).toBe("sqlite");
    expect(runtime.signer.source).toBe("config");
  });

  /**
   * @case An ephemeral store is opt-in, never a silent default
   * @preconditions store: "memory"
   * @expectedResult The in-memory backend is selected
   */
  test("honours an explicit memory store", async () => {
    runtime = await createSuspensionRuntime(new CraftContext(), {
      ...SECRET,
      store: "memory",
    });
    expect(runtime.backend).toBe("memory");
  });

  /**
   * @case A container deployment points the store at a mounted volume
   * @preconditions The store path arrives through the environment
   * @expectedResult The sqlite backend opens at that path
   */
  test("reads the store location from the environment", async () => {
    process.env[SUSPENSION_STORE_ENV] = join(scratch, "from-env.db");
    runtime = await createSuspensionRuntime(new CraftContext(), SECRET);
    expect(runtime.backend).toBe("sqlite");
  });

  /**
   * @case A present-but-empty environment variable is not a store path
   * @preconditions The store env var set to whitespace, no explicit store
   * @expectedResult The default path is used rather than an attempt to open
   *   the working directory, which would fail startup
   */
  test("treats a blank store environment variable as unset", async () => {
    process.env[SUSPENSION_STORE_ENV] = "   ";
    runtime = await createSuspensionRuntime(new CraftContext(), {
      ...SECRET,
      loaders: absentPeerLoaders,
    });
    // Falls back rather than throwing, which is what an unconfigured
    // context does; an explicit path would have rethrown.
    expect(runtime.backend).toBe("memory");
  });

  /**
   * @case A backend of your own plugs in without waiting for core
   * @preconditions A SuspensionStore instance passed as the store
   * @expectedResult That instance is used verbatim
   */
  test("accepts a custom store instance", async () => {
    const custom = new MemorySuspensionStore();
    runtime = await createSuspensionRuntime(new CraftContext(), {
      ...SECRET,
      store: custom,
    });
    expect(runtime.store).toBe(custom);
  });

  /**
   * @case A Node install without better-sqlite3 still starts
   * @preconditions No driver available and no explicit store configured
   * @expectedResult The context falls back to memory and warns loudly, because
   *   a route that may never suspend must not be blocked by a missing peer
   */
  test("falls back to memory with a warning when no driver is available", async () => {
    const context = new CraftContext();
    const warnings = captureWarnings(context);

    runtime = await createSuspensionRuntime(context, {
      ...SECRET,
      loaders: absentPeerLoaders,
    });

    expect(runtime.backend).toBe("memory");
    const message = warnings.at(-1) ?? "";
    expect(message).toMatch(/will NOT survive a restart/);
    expect(message).toMatch(/better-sqlite3/);
  });

  /**
   * @case A deployment that asked for durability is not silently downgraded
   * @preconditions An explicitly configured store path and no available driver
   * @expectedResult Startup fails with the driver's RC5017 rather than
   *   quietly losing every parked approval
   */
  test("fails rather than degrading when a store path was configured", async () => {
    await expect(
      createSuspensionRuntime(new CraftContext(), {
        ...SECRET,
        store: { path: join(scratch, "wanted.db") },
        loaders: absentPeerLoaders,
      }),
    ).rejects.toThrow(expect.objectContaining({ rc: "RC5017" }));
  });

  /**
   * @case A missing signing secret is a startup failure, not a surprise on
   *   the first large payout
   * @preconditions No secret configured and ephemeral keys not permitted
   * @expectedResult RC5040 before any store is opened
   */
  test("refuses to build a runtime without a signing secret", async () => {
    await expect(
      createSuspensionRuntime(new CraftContext(), {
        store: "memory",
        allowEphemeralSecret: false,
      }),
    ).rejects.toThrow(expect.objectContaining({ rc: "RC5040" }));
  });

  /**
   * @case A custom backend keeps its own lifecycle
   * @preconditions A caller-supplied store
   * @expectedResult The runtime reports it as custom and disclaims
   *   ownership, so teardown does not close a resource the caller may
   *   still be using or sharing with another context
   */
  test("does not claim ownership of a supplied store", async () => {
    runtime = await createSuspensionRuntime(new CraftContext(), {
      ...SECRET,
      store: new MemorySuspensionStore(),
    });

    expect(runtime.backend).toBe("custom");
    expect(runtime.ownsStore).toBe(false);
  });

  /**
   * @case An ephemeral key is loud, because it silently breaks resume across
   *   a restart
   * @preconditions Ephemeral keys permitted and no secret configured
   * @expectedResult The runtime builds and warns about the restart consequence
   */
  test("warns when signing with an ephemeral key", async () => {
    const context = new CraftContext();
    const warnings = captureWarnings(context);

    runtime = await createSuspensionRuntime(context, {
      store: "memory",
      allowEphemeralSecret: true,
    });

    expect(runtime.signer.source).toBe("ephemeral");
    expect(warnings.at(-1) ?? "").toMatch(new RegExp(SUSPENSION_SECRET_ENV));
  });
});
