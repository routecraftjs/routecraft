import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  craft,
  direct,
  noop,
  suspensionPlugin,
  type CraftPlugin,
  type SuspensionConfig,
  type TeardownInfo,
} from "../src/index.ts";
import type { SuspensionTestSeams } from "../src/suspension/config.ts";
import type { SqliteDriverLoaders } from "../src/shared/sqlite/driver.ts";
import type { SqliteDatabaseConstructor } from "../src/shared/sqlite/types.ts";
import { CraftContext } from "../src/context.ts";
import { ContextBuilder } from "../src/builder.ts";

/**
 * Unwinding a build or a start that failed partway.
 *
 * `build()` returns no context when it throws, so anything an `apply()`
 * acquired before the failure is unreachable: the caller has no handle to
 * tear down and never had one. Under a supervisor that retries boot, that
 * leaks one handle per attempt, and a held SQLite handle also keeps the file
 * locked, so a transient failure becomes a permanent one reported as lock
 * contention rather than as its real cause.
 *
 * These pin the three properties that make the unwind trustworthy: it runs
 * in reverse, it never touches a plugin that did not apply, and it cannot
 * replace the error the operator actually needs.
 */
describe("unwinding a failed build", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A plugin that "acquires" on apply and records its release order. */
  function resourcePlugin(
    name: string,
    released: string[],
    options: { throwOnTeardown?: boolean } = {},
  ): CraftPlugin {
    return {
      name,
      apply() {},
      teardown() {
        released.push(name);
        if (options.throwOnTeardown) {
          throw new Error(`${name} teardown exploded`);
        }
      },
    };
  }

  /**
   * @case A plugin that throws in apply() leaves no earlier plugin applied
   * @preconditions Three plugins; the third throws from apply()
   * @expectedResult The two that applied are torn down in reverse order, and the plugin that threw is not torn down at all since it never finished acquiring
   */
  test("unwinds applied plugins in reverse order", async () => {
    const released: string[] = [];
    const boom = new Error("third plugin refuses");

    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            resourcePlugin("first", released),
            resourcePlugin("second", released),
            {
              name: "third",
              apply() {
                throw boom;
              },
              teardown() {
                released.push("third");
              },
            },
          ],
        })
        .routes(craft().id("r").from(direct()).to(noop()))
        .build(),
    ).rejects.toThrow("third plugin refuses");

    expect(released).toEqual(["second", "first"]);
  });

  /**
   * @case A failure in registerRoutes() unwinds too, not only a failure in initPlugins()
   * @preconditions Every plugin applies cleanly; two routes share an id, so registerRoutes() throws RC1002
   * @expectedResult The applied plugin is torn down and the duplicate-id error is what surfaces
   */
  test("unwinds when route registration fails", async () => {
    const released: string[] = [];

    await expect(
      new ContextBuilder()
        .with({ plugins: [resourcePlugin("only", released)] })
        .routes([
          craft().id("clash").from(direct()).to(noop()),
          craft().id("clash").from(direct()).to(noop()),
        ])
        .build(),
    ).rejects.toThrow(/clash/);

    expect(released).toEqual(["only"]);
  });

  /**
   * @case An unwind that itself throws neither masks the original error nor strands the remaining plugins
   * @preconditions Three plugins; the third throws from apply() and the second throws from its teardown
   * @expectedResult build() still rejects with the apply error, and the first plugin is released despite the second's teardown throwing
   */
  test("a throwing teardown does not change the surfaced error", async () => {
    const released: string[] = [];

    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            resourcePlugin("first", released),
            resourcePlugin("second", released, { throwOnTeardown: true }),
            {
              name: "third",
              apply() {
                throw new Error("the original cause");
              },
            },
          ],
        })
        .routes(craft().id("r").from(direct()).to(noop()))
        .build(),
    ).rejects.toThrow("the original cause");

    expect(released).toEqual(["second", "first"]);
  });

  /**
   * @case The suspension plugin's SQLite handle is released when a later plugin fails the build
   * @preconditions A real file-backed suspension store whose driver is injected so the opened handle can be observed, then a later plugin throwing from apply()
   * @expectedResult close() ran on the handle the store opened. Reopening the file would prove nothing: bun:sqlite happily opens a second connection while the first is still held, so only the close itself is evidence
   */
  test("releases the suspension store's sqlite handle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-unwind-"));
    dirs.push(dir);
    const path = join(dir, "suspensions.db");

    const closed: string[] = [];
    const loaders: SqliteDriverLoaders = {
      bun: async () => {
        const { Database } = await import("bun:sqlite");
        // `new` on a function returning an object yields that object, so the
        // store gets a real driver whose close() is observable.
        const tracking = function (filename: string): unknown {
          const db = new Database(filename);
          const close = db.close.bind(db);
          db.close = (): void => {
            closed.push(filename);
            close();
          };
          return db;
        };
        return tracking as unknown as SqliteDatabaseConstructor;
      },
      node: () => Promise.reject(new Error("unused under Bun")),
    };
    const suspension: SuspensionConfig & SuspensionTestSeams = {
      store: { path },
      secret: "unwind-test-secret-key-0123456789-abcdef",
      loaders,
    };

    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            suspensionPlugin(suspension),
            {
              name: "late-refusal",
              apply() {
                throw new Error("late plugin refuses");
              },
            },
          ],
        })
        .routes(craft().id("r").from(direct()).to(noop()))
        .build(),
    ).rejects.toThrow("late plugin refuses");

    expect(closed).toEqual([path]);
  });

  /**
   * @case teardown is told the context never finished starting, and whether its own start() ran
   * @preconditions A plugin recording its TeardownInfo, unwound from a build failure
   * @expectedResult partial is true and started is false: nothing started, and a plugin must not be asked to stop what it never began
   */
  test("reports partial and started on a build failure", async () => {
    const seen: TeardownInfo[] = [];

    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            {
              name: "records",
              apply() {},
              start() {},
              teardown(_ctx, info) {
                seen.push(info);
              },
            },
            {
              name: "refuses",
              apply() {
                throw new Error("nope");
              },
            },
          ],
        })
        .routes(craft().id("r").from(direct()).to(noop()))
        .build(),
    ).rejects.toThrow("nope");

    expect(seen).toEqual([{ partial: true, started: false }]);
  });

  /**
   * @case teardown reports partial on a start failure, and started per plugin
   * @preconditions Two plugins with start() hooks; the second throws, so the first started and the second did not
   * @expectedResult Both see partial true; the first sees started true, the second started false
   */
  test("reports partial and started on a start failure", async () => {
    const seen = new Map<string, TeardownInfo>();
    const ctx = new CraftContext({
      plugins: [
        {
          name: "starts-fine",
          apply() {},
          start() {},
          teardown(_c, info) {
            seen.set("starts-fine", info);
          },
        },
        {
          name: "fails-to-start",
          apply() {},
          start() {
            throw new Error("start refused");
          },
          teardown(_c, info) {
            seen.set("fails-to-start", info);
          },
        },
      ],
    });
    ctx.registerRoutes(...craft().id("r").from(direct()).to(noop()).build());

    await expect(ctx.start()).rejects.toThrow("start refused");

    expect(seen.get("starts-fine")).toEqual({ partial: true, started: true });
    expect(seen.get("fails-to-start")).toEqual({
      partial: true,
      started: false,
    });
  });

  /**
   * @case An ordinary shutdown is not reported as partial
   * @preconditions A context that starts fully, then stops
   * @expectedResult partial is false and started reflects that the plugin's own start() ran
   */
  test("an ordinary shutdown is not partial", async () => {
    const seen: TeardownInfo[] = [];
    const ctx = new CraftContext({
      plugins: [
        {
          name: "ordinary",
          apply() {},
          start() {},
          teardown(_c, info) {
            seen.push(info);
          },
        },
      ],
    });
    ctx.registerRoutes(...craft().id("r").from(direct()).to(noop()).build());

    void ctx.start();
    await ctx.whenStarted();
    await ctx.stop();

    expect(seen).toEqual([{ partial: false, started: true }]);
  });
});
