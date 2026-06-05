import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { TelemetryDb } from "../../src/tui/db.js";

/**
 * Seed a telemetry database with the agent/tool event stream the TUI
 * derives its Agents and Tools tabs from. Mirrors what the AI package
 * emits (with snapshot capture on, so tool input/output are present).
 */
function seed(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    context_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    details TEXT NOT NULL,
    exchange_id TEXT,
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE exchanges (
    id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    context_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'started',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    error TEXT,
    PRIMARY KEY (id, context_id)
  )`);

  const ev = db.prepare(
    "INSERT INTO events (timestamp, context_id, event_name, details, exchange_id, correlation_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const emit = (
    ts: string,
    name: string,
    details: Record<string, unknown>,
    exchangeId: string | null,
  ): void => {
    ev.run("ctx", ts, name, JSON.stringify(details), exchangeId, exchangeId);
  };

  // A registered agent that never ran.
  emit(
    "2026-06-05T10:00:00.000Z",
    "agent:registered",
    {
      agentId: "summariser",
      description: "Summarises documents",
      model: "anthropic:claude-opus-4-7",
      source: "registered",
    },
    null,
  );
  // A registered tool.
  emit(
    "2026-06-05T10:00:00.000Z",
    "agent:tool:registered",
    { toolName: "search", description: "Search the web", source: "registered" },
    null,
  );

  // A by-name agent run (researcher) with one tool call.
  emit(
    "2026-06-05T10:01:00.000Z",
    "route:r1:agent:started",
    {
      routeId: "r1",
      exchangeId: "ex1",
      agentName: "researcher",
      model: "anthropic:claude-opus-4-7",
      toolNames: ["search"],
      maxTurns: 20,
    },
    "ex1",
  );
  emit(
    "2026-06-05T10:01:01.000Z",
    "route:r1:agent:tool:invoked",
    {
      routeId: "r1",
      exchangeId: "ex1",
      toolCallId: "c1",
      toolName: "search",
      _snapshot: { input: { q: "hello" } },
    },
    "ex1",
  );
  emit(
    "2026-06-05T10:01:02.000Z",
    "route:r1:agent:tool:result",
    {
      routeId: "r1",
      exchangeId: "ex1",
      toolCallId: "c1",
      toolName: "search",
      _snapshot: { output: "a result" },
      duration: 5,
    },
    "ex1",
  );
  emit(
    "2026-06-05T10:01:03.000Z",
    "route:r1:agent:finished",
    {
      routeId: "r1",
      exchangeId: "ex1",
      agentName: "researcher",
      model: "anthropic:claude-opus-4-7",
      finishReason: "stop",
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    },
    "ex1",
  );

  // An inline agent run (keyed by route) that errored.
  emit(
    "2026-06-05T10:02:00.000Z",
    "route:r2:agent:started",
    { routeId: "r2", exchangeId: "ex2", model: "anthropic:claude-haiku-4-5" },
    "ex2",
  );
  emit(
    "2026-06-05T10:02:01.000Z",
    "route:r2:agent:error",
    { routeId: "r2", exchangeId: "ex2", model: "anthropic:claude-haiku-4-5" },
    "ex2",
  );

  const ex = db.prepare(
    "INSERT INTO exchanges (id, route_id, context_id, correlation_id, status, started_at, completed_at, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  ex.run(
    "ex1",
    "r1",
    "ctx",
    "ex1",
    "completed",
    "2026-06-05T10:01:00.000Z",
    "2026-06-05T10:01:03.000Z",
    3000,
    null,
  );
  ex.run(
    "ex2",
    "r2",
    "ctx",
    "ex2",
    "failed",
    "2026-06-05T10:02:00.000Z",
    null,
    null,
    "boom",
  );
  db.close();
}

describe("TelemetryDb agents/tools derivation", () => {
  let dir: string;
  let dbPath: string;
  let db: TelemetryDb;

  beforeEach(async () => {
    dir = resolve(tmpdir(), `routecraft-tui-db-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dbPath = resolve(dir, "telemetry.db");
    seed(dbPath);
    db = await TelemetryDb.open(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * @case getAgents lists registered, by-name and inline agents
   * @preconditions Seed with a never-run registered agent, a by-name run, an inline run
   * @expectedResult Three agents with correct source, model, run/error counts and tokens
   */
  test("getAgents derives registered, by-name and inline agents", () => {
    const agents = db.getAgents();
    const byKey = new Map(agents.map((a) => [a.key, a]));

    const researcher = byKey.get("researcher");
    expect(researcher).toBeDefined();
    expect(researcher!.source).toBe("registered");
    expect(researcher!.runCount).toBe(1);
    expect(researcher!.errorCount).toBe(0);
    expect(researcher!.totalTokens).toBe(30);
    expect(researcher!.model).toBe("anthropic:claude-opus-4-7");

    const inline = byKey.get("r2");
    expect(inline).toBeDefined();
    expect(inline!.source).toBe("inline");
    expect(inline!.runCount).toBe(1);
    expect(inline!.errorCount).toBe(1);
    expect(inline!.model).toBe("anthropic:claude-haiku-4-5");

    const summariser = byKey.get("summariser");
    expect(summariser).toBeDefined();
    expect(summariser!.source).toBe("registered");
    expect(summariser!.runCount).toBe(0);
    expect(summariser!.description).toBe("Summarises documents");
  });

  /**
   * @case getAgentRuns returns the dispatching exchanges for an agent
   * @preconditions researcher ran once in exchange ex1
   * @expectedResult One exchange row (ex1) from the exchanges table
   */
  test("getAgentRuns returns runs for a by-name agent", () => {
    const runs = db.getAgentRuns("researcher", "registered");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe("ex1");
    expect(runs[0]!.status).toBe("completed");
  });

  /**
   * @case getAgentRunInfo summarises model, finish reason and tokens
   * @preconditions ex1 has started + finished events
   * @expectedResult Finished status with model and token counts
   */
  test("getAgentRunInfo summarises a run", () => {
    const info = db.getAgentRunInfo("ex1");
    expect(info).not.toBeNull();
    expect(info!.status).toBe("finished");
    expect(info!.model).toBe("anthropic:claude-opus-4-7");
    expect(info!.finishReason).toBe("stop");
    expect(info!.inputTokens).toBe(20);
    expect(info!.outputTokens).toBe(10);
    expect(info!.totalTokens).toBe(30);
  });

  /**
   * @case getAgentRunToolCalls correlates invoked + result into one call
   * @preconditions ex1 has one invoked + result for toolCallId c1
   * @expectedResult One tool call with captured input/output and result status
   */
  test("getAgentRunToolCalls correlates a tool call with I/O", () => {
    const calls = db.getAgentRunToolCalls("ex1");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.toolName).toBe("search");
    expect(call.status).toBe("result");
    expect(call.durationMs).toBe(5);
    expect(call.hasInput).toBe(true);
    expect(call.hasOutput).toBe(true);
    expect(call.input).toContain("hello");
    expect(call.output).toContain("a result");
  });

  /**
   * @case getTools derives the tool list from registration + invocations
   * @preconditions search is registered and invoked once
   * @expectedResult search present with callCount 1
   */
  test("getTools derives tools", () => {
    const tools = db.getTools();
    const search = tools.find((t) => t.name === "search");
    expect(search).toBeDefined();
    expect(search!.callCount).toBe(1);
    expect(search!.errorCount).toBe(0);
  });

  /**
   * @case getToolCalls returns per-tool invocation history
   * @preconditions search invoked once in ex1
   * @expectedResult One call row with result status and exchange ex1
   */
  test("getToolCalls returns invocation history for a tool", () => {
    const calls = db.getToolCalls("search");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.exchangeId).toBe("ex1");
    expect(calls[0]!.status).toBe("result");
  });
});
