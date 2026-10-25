import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  http,
  noop,
  simple,
  telemetry,
  SqliteConnection,
  type CraftConfig,
} from "../src/index.ts";

const PARENT_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN = "00f067aa0ba902b7";

function tracing(): {
  exporter: InMemorySpanExporter;
  provider: BasicTracerProvider;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, provider };
}

/** The exchange span of a route, by its route attribute. */
function exchangeSpan(
  spans: readonly ReadableSpan[],
  routeId: string,
): ReadableSpan {
  const span = spans.find(
    (s) =>
      s.attributes["routecraft.span.kind"] === "exchange" &&
      s.attributes["routecraft.route.id"] === routeId,
  );
  if (!span) throw new Error(`no exchange span for ${routeId}`);
  return span;
}

describe("Telemetry: causation", () => {
  let t: TestContext | undefined;
  let close: (() => Promise<void>) | undefined;
  let testDir: string;

  beforeEach(() => {
    testDir = resolve(tmpdir(), `routecraft-telemetry-cause-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (t) await t.stop();
    if (close) await close();
    t = undefined;
    close = undefined;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * @case A direct() callee's exchange span is a child of its caller's
   * @preconditions telemetry with an in-memory tracer and no SQLite; a caller route sends to a callee through direct()
   * @expectedResult Both spans share the trace id, the callee's parent span id is the caller's span id, and the callee carries routecraft.causation.id naming the caller exchange
   */
  test("a callee's span is parented to its caller's", async () => {
    const { exporter, provider } = tracing();
    t = await testContext()
      .with({
        plugins: [telemetry({ disableSqlite: true, tracerProvider: provider })],
      })
      .routes([
        craft().id("span-caller").from(simple("x")).to(direct("span-callee")),
        craft()
          .id("span-callee")
          .from(direct())
          .to(() => "ok"),
      ])
      .build();
    await t.test();

    const spans = exporter.getFinishedSpans();
    const caller = exchangeSpan(spans, "span-caller");
    const callee = exchangeSpan(spans, "span-callee");
    expect(callee.spanContext().traceId).toBe(caller.spanContext().traceId);
    expect(callee.parentSpanContext?.spanId).toBe(caller.spanContext().spanId);
    expect(callee.attributes["routecraft.causation.id"]).toBe(
      caller.attributes["routecraft.exchange.id"],
    );
    expect(caller.parentSpanContext).toBeUndefined();
  });

  /**
   * @case With telemetry on, an outbound traceparent names the live exchange span
   * @preconditions telemetry with an in-memory tracer; a route calls a recording server with http()
   * @expectedResult The traceparent's trace and parent ids are the route's exchange span's
   */
  test("an outbound traceparent names the exchange span", async () => {
    const requests: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      requests.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    close = () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });
    const port = (server.address() as AddressInfo).port;
    const { exporter, provider } = tracing();
    t = await testContext()
      .with({
        plugins: [telemetry({ disableSqlite: true, tracerProvider: provider })],
      })
      .routes(
        craft()
          .id("span-sender")
          .from(simple("x"))
          .to(http({ url: `http://127.0.0.1:${port}/`, method: "POST" })),
      )
      .build();
    await t.test();

    const span = exchangeSpan(exporter.getFinishedSpans(), "span-sender");
    const { traceId, spanId } = span.spanContext();
    expect(requests[0]!["traceparent"]).toBe(`00-${traceId}-${spanId}-01`);
  });

  /**
   * @case An adopted remote context becomes the exchange span's remote parent
   * @preconditions telemetry with an in-memory tracer; an http door with traceContext "always" receives a traceparent
   * @expectedResult The door's exchange span has the remote trace id and the remote span as its parent
   */
  test("an adopted context parents the exchange span", async () => {
    const { exporter, provider } = tracing();
    let port = 0;
    t = await testContext()
      .with({
        servers: { default: { port: 0, host: "127.0.0.1" } },
        http: { traceContext: "always" },
        plugins: [telemetry({ disableSqlite: true, tracerProvider: provider })],
      } as CraftConfig)
      .on("server:listening", (({ details }: { details: { port: number } }) => {
        port = details.port;
      }) as never)
      .routes(
        craft()
          .id("span-door")
          .from(http({ path: "/in", method: "POST" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    await fetch(`http://127.0.0.1:${port}/in`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        traceparent: `00-${PARENT_TRACE}-${PARENT_SPAN}-01`,
      },
      body: "{}",
    });
    await t.drain();

    const span = exchangeSpan(exporter.getFinishedSpans(), "span-door");
    expect(span.spanContext().traceId).toBe(PARENT_TRACE);
    expect(span.parentSpanContext?.spanId).toBe(PARENT_SPAN);
    expect(span.parentSpanContext?.isRemote).toBe(true);
  });

  /**
   * @case A telemetry database an earlier version created gains the causation columns
   * @preconditions A database whose events and exchanges tables predate causation_id
   * @expectedResult Opening it adds causation_id to both tables, keeps the existing row, and creates the causation index
   */
  test("migrates an existing database in place", async () => {
    const dbPath = resolve(testDir, "old.db");
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
      context_id TEXT NOT NULL, event_name TEXT NOT NULL, details TEXT NOT NULL,
      exchange_id TEXT, correlation_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    old.exec(`CREATE TABLE exchanges (
      id TEXT NOT NULL, route_id TEXT NOT NULL, context_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'started',
      started_at TEXT NOT NULL, completed_at TEXT, duration_ms INTEGER, error TEXT,
      PRIMARY KEY (id, context_id))`);
    old.exec(
      "INSERT INTO exchanges (id, route_id, context_id, correlation_id, started_at) VALUES ('e1', 'r', 'c', 'k', 'now')",
    );
    old.close();

    const conn = await SqliteConnection.open({ dbPath });
    expect(conn).not.toBeNull();
    conn!.close();

    const db = new Database(dbPath, { readonly: true });
    const columns = (table: string) =>
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((c) => c.name);
    expect(columns("events")).toContain("causation_id");
    expect(columns("exchanges")).toContain("causation_id");
    expect(
      db.prepare("SELECT causation_id FROM exchanges WHERE id = 'e1'").get(),
    ).toEqual({ causation_id: null });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_exchanges_causation_id'",
        )
        .get(),
    ).toEqual({ name: "idx_exchanges_causation_id" });
    db.close();
  });

  /**
   * @case The SQLite sink records each exchange's cause, on its row and on its events
   * @preconditions telemetry with SQLite; a caller route sends to a callee through direct()
   * @expectedResult The callee's exchange row and its route:exchange:started event carry the caller's exchange id as causation_id; the caller's carry NULL
   */
  test("records causation_id on rows and events", async () => {
    const dbPath = resolve(testDir, "telemetry.db");
    t = await testContext()
      .with({ plugins: [telemetry({ sqlite: { dbPath } })] })
      .routes([
        craft().id("row-caller").from(simple("x")).to(direct("row-callee")),
        craft()
          .id("row-callee")
          .from(direct())
          .to(() => "ok"),
      ])
      .build();
    await t.test();

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT id, route_id, causation_id FROM exchanges")
      .all() as { id: string; route_id: string; causation_id: string | null }[];
    const caller = rows.find((r) => r.route_id === "row-caller")!;
    const callee = rows.find((r) => r.route_id === "row-callee")!;
    expect(caller.causation_id).toBeNull();
    expect(callee.causation_id).toBe(caller.id);
    const started = db
      .prepare(
        "SELECT causation_id FROM events WHERE event_name = 'route:exchange:started' AND exchange_id = ?",
      )
      .get(callee.id) as { causation_id: string | null };
    expect(started.causation_id).toBe(caller.id);
    db.close();
  });
});
