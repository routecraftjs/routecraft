import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { TelemetryDb } from "../../src/tui/db.js";
import { seedTelemetryDb } from "./fixtures.js";

describe("TelemetryDb agents/tools derivation", () => {
  let dir: string;
  let dbPath: string;
  let db: TelemetryDb;

  beforeEach(async () => {
    dir = resolve(tmpdir(), `routecraft-tui-db-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dbPath = resolve(dir, "telemetry.db");
    seedTelemetryDb(dbPath);
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
   * @preconditions search invoked once in ex1; other tools invoked in ex3
   * @expectedResult One call row with result status and exchange ex1, with
   *   the SQL-side toolName filter excluding the other tools' events
   */
  test("getToolCalls returns invocation history for a tool", () => {
    const calls = db.getToolCalls("search");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.exchangeId).toBe("ex1");
    expect(calls[0]!.status).toBe("result");
  });

  /**
   * @case Tool error persisted with snapshot capture off carries errorName only
   * @preconditions fetch errored in ex3 with errorName but no _snapshot envelope
   * @expectedResult Call has error status, errorName TypeError, and null error payload
   */
  test("tool error without snapshots surfaces errorName and no payload", () => {
    const calls = db.getToolCalls("fetch");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.status).toBe("error");
    expect(call.errorName).toBe("TypeError");
    expect(call.error).toBeNull();
    expect(call.durationMs).toBe(3);
  });

  /**
   * @case Legacy pre-envelope tool error events still surface their payload
   * @preconditions legacy errored in ex3 with a top-level error field
   * @expectedResult Call has error status and the serialized legacy error payload
   */
  test("legacy top-level tool error payload is preserved", () => {
    const calls = db.getToolCalls("legacy");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.status).toBe("error");
    expect(call.error).toContain("boom");
  });

  /**
   * @case getAgents incremental aggregation picks up events after the first call
   * @preconditions getAgents called once, then a new agent:started event is written
   * @expectedResult Second getAgents call reflects the new run without rescanning
   */
  test("getAgents aggregates incrementally across polls", () => {
    const before = db.getAgents();
    const researcherBefore = before.find((a) => a.key === "researcher");
    expect(researcherBefore!.runCount).toBe(1);

    const writer = new Database(dbPath);
    writer
      .prepare(
        "INSERT INTO events (timestamp, context_id, event_name, details, exchange_id, correlation_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "2026-06-05T10:04:00.000Z",
        "ctx",
        "route:r1:agent:started",
        JSON.stringify({
          routeId: "r1",
          exchangeId: "ex9",
          agentName: "researcher",
          model: "anthropic:claude-opus-4-7",
          toolNames: [],
          maxTurns: 20,
        }),
        "ex9",
        "ex9",
      );
    writer.close();

    const after = db.getAgents();
    const researcherAfter = after.find((a) => a.key === "researcher");
    expect(researcherAfter!.runCount).toBe(2);
  });

  /**
   * @case getTools incremental aggregation picks up new invocations
   * @preconditions getTools called once, then a new tool:invoked event is written
   * @expectedResult Second getTools call shows the increased call count
   */
  test("getTools aggregates incrementally across polls", () => {
    const before = db.getTools();
    const searchBefore = before.find((t) => t.name === "search");
    expect(searchBefore!.callCount).toBe(1);

    const writer = new Database(dbPath);
    writer
      .prepare(
        "INSERT INTO events (timestamp, context_id, event_name, details, exchange_id, correlation_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "2026-06-05T10:04:01.000Z",
        "ctx",
        "route:r1:agent:tool:invoked",
        JSON.stringify({
          routeId: "r1",
          exchangeId: "ex9",
          toolCallId: "c9",
          toolName: "search",
        }),
        "ex9",
        "ex9",
      );
    writer.close();

    const after = db.getTools();
    const searchAfter = after.find((t) => t.name === "search");
    expect(searchAfter!.callCount).toBe(2);
  });
});
