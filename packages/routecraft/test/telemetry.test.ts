import { describe, test, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, log } from "@routecraft/routecraft";
import { telemetry } from "@routecraft/routecraft";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3");

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
    // Clean up test database
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  /**
   * @case TelemetryPlugin creates the SQLite database file on apply
   * @preconditions Fresh temp directory, no existing database
   * @expectedResult Database file exists after context starts
   */
  test("creates database file on apply", async () => {
    const plugin = telemetry({ dbPath });

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
   * @case TelemetryPlugin creates all required tables
   * @preconditions Fresh database
   * @expectedResult events, routes, and exchanges tables exist
   */
  test("creates all required tables", async () => {
    const plugin = telemetry({ dbPath });

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
   * @case TelemetryPlugin enables WAL mode by default
   * @preconditions Fresh database with default options
   * @expectedResult SQLite journal_mode is wal
   */
  test("enables WAL mode by default", async () => {
    const plugin = telemetry({ dbPath });

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
    const result = db.pragma("journal_mode") as Array<{
      journal_mode: string;
    }>;
    db.close();

    expect(result[0]!.journal_mode).toBe("wal");
  });

  /**
   * @case TelemetryPlugin records route registrations
   * @preconditions Context with one route and TelemetryPlugin
   * @expectedResult Route appears in the routes table after context starts
   */
  test("records route registrations", async () => {
    const plugin = telemetry({
      dbPath,
      flushIntervalMs: 100,
    });

    const route = craft()
      .id("recorded-route")
      .from(simple([1, 2]))
      .to(log());
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(route)
      .build();

    await t.ctx.start();
    // Wait for flush
    await new Promise((r) => setTimeout(r, 200));

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
   * @case TelemetryPlugin records exchange lifecycle events
   * @preconditions Context with simple source producing 3 messages
   * @expectedResult Exchange records appear in the exchanges table with correct status
   */
  test("records exchange lifecycle", async () => {
    const plugin = telemetry({
      dbPath,
      flushIntervalMs: 100,
      batchSize: 5,
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
    // Wait for processing and flush
    await new Promise((r) => setTimeout(r, 300));

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
   * @case TelemetryPlugin records events in the events table
   * @preconditions Context with simple source
   * @expectedResult Events table contains entries after context runs
   */
  test("records events to events table", async () => {
    const plugin = telemetry({
      dbPath,
      flushIntervalMs: 100,
      batchSize: 5,
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
    // Wait for flush
    await new Promise((r) => setTimeout(r, 300));

    const db = new Database(dbPath, { readonly: true });
    const eventCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM events")
      .get() as { cnt: number };
    db.close();

    // Should have at least context:starting, context:started, route events, exchange events
    expect(eventCount.cnt).toBeGreaterThan(0);
  });

  /**
   * @case TelemetryPlugin custom dbPath option works
   * @preconditions Custom path in a nested temp directory
   * @expectedResult Database is created at the specified custom path
   */
  test("respects custom dbPath option", async () => {
    const customPath = resolve(testDir, "nested", "custom.db");
    const plugin = telemetry({ dbPath: customPath });

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
   * @case TelemetryPlugin teardown flushes and closes the database
   * @preconditions Context with TelemetryPlugin that has buffered events
   * @expectedResult All buffered events are flushed before database closes
   */
  test("teardown flushes buffered events", async () => {
    const plugin = telemetry({
      dbPath,
      flushIntervalMs: 60000, // Very long interval so events stay buffered
      batchSize: 1000, // Very large batch so events stay buffered
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
    // Events are buffered but not flushed yet (long interval, large batch)
    // Context stop triggers plugin teardown which flushes

    const db = new Database(dbPath, { readonly: true });
    const eventCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM events")
      .get() as { cnt: number };
    db.close();

    // After context.start() completes (which calls stop() when all routes finish),
    // teardown should have flushed all events
    expect(eventCount.cnt).toBeGreaterThan(0);
  });
});
