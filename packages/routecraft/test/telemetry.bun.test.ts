import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  log,
  telemetry,
  SqliteConnection,
} from "@routecraft/routecraft";
import { SqliteEventWriter } from "../src/telemetry/sqlite-event-writer.ts";
import type { TelemetryEvent } from "../src/telemetry/types.ts";

/**
 * Helper: create a telemetry() plugin wired to a specific SQLite database.
 */
function sqliteTelemetry(
  dbPath: string,
  sqliteOpts?: {
    eventBatchSize?: number;
    eventFlushIntervalMs?: number;
    captureSnapshots?: boolean;
  },
) {
  return telemetry({ sqlite: { dbPath, ...sqliteOpts } });
}

describe("TelemetryPlugin", () => {
  let t: TestContext;
  let dbPath: string;
  let testDir: string;

  beforeEach(() => {
    testDir = resolve(tmpdir(), `routecraft-telemetry-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = resolve(testDir, "telemetry.db");
  });

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  /**
   * @case telemetry() with SQLite creates the database file
   * @preconditions Fresh temp directory, no existing database
   * @expectedResult Database file exists after context starts
   */
  test("creates database file on apply", async () => {
    const plugin = sqliteTelemetry(dbPath);

    const route = craft()
      .id("test-route")
      .from(simple([1]))
      .to(log());
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(route)
      .build();

    await t.ctx.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(existsSync(dbPath)).toBe(true);
  });

  /**
   * @case telemetry() with SQLite creates all required tables
   * @preconditions Fresh database
   * @expectedResult events, routes, and exchanges tables exist
   */
  test("creates all required tables", async () => {
    const plugin = sqliteTelemetry(dbPath);

    const route = craft()
      .id("schema-test")
      .from(simple([1]))
      .to(log());
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(route)
      .build();

    await t.ctx.start();
    await new Promise((r) => setTimeout(r, 50));

    const db = new Database(dbPath, { readonly: true });
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    db.close();

    const tableNames = tables.map((t: { name: string }) => t.name);
    expect(tableNames).toContain("events");
    expect(tableNames).toContain("routes");
    expect(tableNames).toContain("exchanges");
  });

  /**
   * @case telemetry() with SQLite enables WAL mode by default
   * @preconditions Fresh database with default options
   * @expectedResult SQLite journal_mode is wal
   */
  test("enables WAL mode by default", async () => {
    const plugin = sqliteTelemetry(dbPath);

    const route = craft()
      .id("wal-test")
      .from(simple([1]))
      .to(log());
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(route)
      .build();

    await t.ctx.start();
    await new Promise((r) => setTimeout(r, 50));

    const db = new Database(dbPath, { readonly: true });
    const result = db.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    db.close();

    expect(result.journal_mode).toBe("wal");
  });

  /**
   * @case telemetry() records route registrations via SqliteSpanProcessor
   * @preconditions Context with one route and telemetry plugin
   * @expectedResult Route appears in the routes table after context starts
   */
  test("records route registrations", async () => {
    const plugin = sqliteTelemetry(dbPath, { eventFlushIntervalMs: 100 });

    const route = craft()
      .id("recorded-route")
      .from(simple([1, 2]))
      .to(log());
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(route)
      .build();

    await t.ctx.start();
    // Stop triggers teardown which flushes buffered telemetry, avoiding a fixed sleep.
    await t.stop();

    const db = new Database(dbPath, { readonly: true });
    const routes = db
      .prepare("SELECT * FROM routes WHERE id = ?")
      .all("recorded-route") as Array<{
      id: string;
      context_id: string;
      status: string;
    }>;
    db.close();

    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes[0]!.id).toBe("recorded-route");
  });

  /**
   * @case telemetry() records exchange lifecycle via SqliteSpanProcessor
   * @preconditions Context with simple source producing 3 messages
   * @expectedResult Exchange records appear in the exchanges table with correct status
   */
  test("records exchange lifecycle", async () => {
    const plugin = sqliteTelemetry(dbPath, {
      eventFlushIntervalMs: 100,
      eventBatchSize: 5,
    });

    const route = craft()
      .id("exchange-test")
      .from(simple([10, 20, 30]))
      .to(log());
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(route)
      .build();

    await t.ctx.start();
    await t.stop();

    const db = new Database(dbPath, { readonly: true });
    const exchanges = db
      .prepare("SELECT * FROM exchanges WHERE route_id = ? ORDER BY started_at")
      .all("exchange-test") as Array<{
      id: string;
      route_id: string;
      status: string;
      duration_ms: number | null;
    }>;
    db.close();

    expect(exchanges.length).toBe(3);
    for (const ex of exchanges) {
      expect(ex.status).toBe("completed");
      expect(ex.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * @case telemetry() records events in the events table via SqliteEventWriter
   * @preconditions Context with simple source
   * @expectedResult Events table contains entries after context runs
   */
  test("records events to events table", async () => {
    const plugin = sqliteTelemetry(dbPath, {
      eventFlushIntervalMs: 100,
      eventBatchSize: 5,
    });

    const route = craft()
      .id("events-test")
      .from(simple([1]))
      .to(log());
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(route)
      .build();

    await t.ctx.start();
    await t.stop();

    const db = new Database(dbPath, { readonly: true });
    const eventCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM events")
      .get() as { cnt: number };
    db.close();

    expect(eventCount.cnt).toBeGreaterThan(0);
  });

  /**
   * @case The `_snapshot` envelope is stripped from event details when
   *   snapshot capture is off (the default)
   * @preconditions captureSnapshots not set; an event carrying a
   *   `_snapshot` sub-payload is emitted while the context runs
   * @expectedResult The persisted details omit `_snapshot` and its
   *   contents, but retain the non-sensitive sibling fields
   */
  test("drops _snapshot from event details when captureSnapshots is off", async () => {
    const plugin = sqliteTelemetry(dbPath, { eventFlushIntervalMs: 50 });
    const route = craft()
      .id("snap-off")
      .from(simple([1]))
      .to(log());
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(route)
      .build();

    // Emit the synthetic agent-tool event from inside a live exchange so
    // the telemetry subscription is still active (a finite source tears
    // the context down by the time start() resolves).
    t.ctx.once("route:snap-off:exchange:started" as never, () => {
      t.ctx.emit(
        "route:snap-off:agent:tool:result" as never,
        {
          routeId: "snap-off",
          exchangeId: "ex-1",
          toolName: "secretTool",
          _snapshot: { output: "TOP_SECRET_OUTPUT" },
        } as never,
      );
    });
    await t.test();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT details FROM events WHERE event_name = ?")
      .get("route:snap-off:agent:tool:result") as
      | { details: string }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.details).not.toContain("_snapshot");
    expect(row!.details).not.toContain("TOP_SECRET_OUTPUT");
    expect(row!.details).toContain("secretTool");
  });

  /**
   * @case The `_snapshot` envelope is persisted when snapshot capture is on
   * @preconditions captureSnapshots: true; an event carrying a
   *   `_snapshot` sub-payload is emitted while the context runs
   * @expectedResult The persisted details retain `_snapshot` and its contents
   */
  test("keeps _snapshot in event details when captureSnapshots is on", async () => {
    const plugin = sqliteTelemetry(dbPath, {
      eventFlushIntervalMs: 50,
      captureSnapshots: true,
    });
    const route = craft()
      .id("snap-on")
      .from(simple([1]))
      .to(log());
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(route)
      .build();

    t.ctx.once("route:snap-on:exchange:started" as never, () => {
      t.ctx.emit(
        "route:snap-on:agent:tool:result" as never,
        {
          routeId: "snap-on",
          exchangeId: "ex-1",
          toolName: "secretTool",
          _snapshot: { output: "VISIBLE_OUTPUT" },
        } as never,
      );
    });
    await t.test();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT details FROM events WHERE event_name = ?")
      .get("route:snap-on:agent:tool:result") as
      | { details: string }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.details).toContain("_snapshot");
    expect(row!.details).toContain("VISIBLE_OUTPUT");
  });

  /**
   * @case telemetry() with custom dbPath creates database at specified location
   * @preconditions Custom path in a nested temp directory
   * @expectedResult Database is created at the specified custom path
   */
  test("respects custom dbPath option", async () => {
    const customPath = resolve(testDir, "nested", "custom.db");
    const plugin = sqliteTelemetry(customPath);

    const route = craft()
      .id("custom-path")
      .from(simple([1]))
      .to(log());
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(route)
      .build();

    await t.ctx.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(existsSync(customPath)).toBe(true);
  });

  /**
   * @case telemetry() teardown flushes buffered events
   * @preconditions Context with telemetry that has buffered events
   * @expectedResult All buffered events are flushed before close
   */
  test("teardown flushes buffered events", async () => {
    const plugin = sqliteTelemetry(dbPath, {
      eventFlushIntervalMs: 60000,
      eventBatchSize: 1000,
    });

    const route = craft()
      .id("teardown-test")
      .from(simple([1, 2]))
      .to(log());
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(route)
      .build();

    await t.ctx.start();

    // Trigger teardown to flush buffered events before querying
    await t.stop();

    const db = new Database(dbPath, { readonly: true });
    const eventCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM events")
      .get() as { cnt: number };
    db.close();

    expect(eventCount.cnt).toBeGreaterThan(0);
  });

  /**
   * @case telemetry() with disableSqlite does not create database
   * @preconditions disableSqlite: true, no tracerProvider
   * @expectedResult No database file created
   */
  test("disableSqlite prevents database creation", async () => {
    const plugin = telemetry({ disableSqlite: true });

    const route = craft()
      .id("no-sqlite")
      .from(simple([1]))
      .to(log());
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(route)
      .build();

    await t.ctx.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(existsSync(dbPath)).toBe(false);
  });

  /**
   * @case SqliteConnection.open returns a usable connection when the driver loader resolves
   * @preconditions Fresh temp directory; default loadDriver resolves to bun:sqlite (native under Bun, no substitution needed)
   * @expectedResult Connection is non-null and the db file is created on disk
   */
  test("SqliteConnection.open succeeds with a resolvable driver", async () => {
    const conn = await SqliteConnection.open({ dbPath });
    expect(conn).not.toBeNull();
    conn!.close();
    expect(existsSync(dbPath)).toBe(true);
  });

  /**
   * @case SqliteConnection.open returns null when the runtime is not Bun
   * @preconditions Driver loader is overridden to throw, simulating Node where bun:sqlite cannot resolve
   * @expectedResult open() resolves to null so the calling plugin can skip the SQLite path with a warn log
   */
  test("SqliteConnection.open returns null when bun:sqlite is unavailable", async () => {
    const original = SqliteConnection.loadDriver;
    SqliteConnection.loadDriver = async () => {
      throw new Error("bun:sqlite is only available under Bun");
    };
    try {
      const conn = await SqliteConnection.open({ dbPath });
      expect(conn).toBeNull();
    } finally {
      SqliteConnection.loadDriver = original;
    }
  });
});

describe("SqliteEventWriter flush durability", () => {
  function makeEvent(i: number): TelemetryEvent {
    return {
      timestamp: new Date().toISOString(),
      contextId: "ctx",
      eventName: `event-${i}`,
      details: "{}",
    };
  }

  /**
   * Build a fake SqliteConnection whose transaction fails for the first
   * `failCount` invocations, then succeeds. `persisted` records every event
   * that reaches the prepared statement's run() inside a committed transaction.
   */
  function fakeConnection(failCount: number) {
    const persisted: TelemetryEvent[] = [];
    const warnings: string[] = [];
    let calls = 0;
    const connection = {
      logger: {
        warn: (_b: Record<string, unknown>, message: string) =>
          warnings.push(message),
      },
      db: {
        prepare: () => ({
          run: (...args: unknown[]) => {
            persisted.push({
              timestamp: args[0] as string,
              contextId: args[1] as string,
              eventName: args[2] as string,
              details: args[3] as string,
            });
          },
        }),
        transaction:
          (fn: (events: TelemetryEvent[]) => void) =>
          (events: TelemetryEvent[]) => {
            calls += 1;
            if (calls <= failCount) {
              throw new Error("database is locked");
            }
            fn(events);
          },
      },
    };
    return { connection, persisted, warnings };
  }

  /**
   * @case A failed flush retains its batch and a later flush persists it
   * @preconditions Writer over a connection whose first transaction throws, the second succeeds
   * @expectedResult Nothing persists on the failing flush; the retained batch persists on the next flush with no loss
   */
  test("retains events on a failed flush and persists them on retry", () => {
    const { connection, persisted } = fakeConnection(1);
    // Large interval so the internal timer never fires during the test.
    const writer = new SqliteEventWriter(
      connection as unknown as SqliteConnection,
      50,
      60_000,
    );

    writer.write(makeEvent(1));
    writer.write(makeEvent(2));

    writer.flush(); // transaction #1 throws -> batch must be retained
    expect(persisted.length).toBe(0);

    writer.flush(); // transaction #2 succeeds -> retained batch is persisted
    expect(persisted.map((e) => e.eventName)).toEqual(["event-1", "event-2"]);

    writer.flush(); // nothing left to flush
    expect(persisted.length).toBe(2);

    writer.close();
  });

  /**
   * @case A sustained sink outage bounds the in-memory buffer
   * @preconditions Writer over a connection whose transaction always throws, fed more than the retention cap
   * @expectedResult The buffer never exceeds the 10k cap and the oldest events are dropped with a warning
   */
  test("bounds the buffer during a sustained outage", () => {
    const { connection, persisted, warnings } = fakeConnection(
      Number.POSITIVE_INFINITY,
    );
    // batchSize 1 makes every write() trigger a (failing) flush.
    const writer = new SqliteEventWriter(
      connection as unknown as SqliteConnection,
      1,
      60_000,
    );

    for (let i = 0; i < 10_050; i++) {
      writer.write(makeEvent(i));
    }

    expect(persisted.length).toBe(0);
    const buffered = (writer as unknown as { buffer: TelemetryEvent[] }).buffer
      .length;
    expect(buffered).toBeLessThanOrEqual(10_000);
    expect(warnings.some((m) => m.includes("dropped oldest events"))).toBe(
      true,
    );

    writer.close();
  });
});
