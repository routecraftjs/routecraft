import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CraftContext,
  MemorySuspensionStore,
  SUSPENSION_SECRET_ENV,
  SUSPENSION_STORE_ENV,
  createSuspensionRuntime,
  rcError,
  type SuspensionRuntime,
} from "../src/index.ts";
import type { SqliteDriverLoaders } from "../src/suspension/sqlite-driver.ts";

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
          'suspension store (sqlite) adapter requires the optional peer dependency "better-sqlite3".',
      }),
    ),
};

const SECRET = { secret: "runtime-test-secret" };

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

  afterEach(async () => {
    if (runtime) await runtime.store.close();
    runtime = undefined;
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
    const previous = process.env[SUSPENSION_STORE_ENV];
    process.env[SUSPENSION_STORE_ENV] = join(scratch, "from-env.db");
    try {
      runtime = await createSuspensionRuntime(new CraftContext(), SECRET);
      expect(runtime.backend).toBe("sqlite");
    } finally {
      if (previous === undefined) delete process.env[SUSPENSION_STORE_ENV];
      else process.env[SUSPENSION_STORE_ENV] = previous;
    }
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
    const previous = process.env[SUSPENSION_SECRET_ENV];
    delete process.env[SUSPENSION_SECRET_ENV];
    try {
      await expect(
        createSuspensionRuntime(new CraftContext(), {
          store: "memory",
          allowEphemeralSecret: false,
        }),
      ).rejects.toThrow(expect.objectContaining({ rc: "RC5040" }));
    } finally {
      if (previous !== undefined) process.env[SUSPENSION_SECRET_ENV] = previous;
    }
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
