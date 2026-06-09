import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { render } from "ink-testing-library";
import { App } from "../../src/tui/app.js";
import { TelemetryDb } from "../../src/tui/db.js";
import { seedTelemetryDb } from "./fixtures.js";

/** Let React flush state updates triggered by stdin input. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
}

const ESC = "";
const ENTER = "\r";

describe("TUI App navigation", () => {
  let dir: string;
  let dbPath: string;
  let db: TelemetryDb;
  let instance: ReturnType<typeof render>;

  beforeEach(async () => {
    dir = resolve(tmpdir(), `routecraft-tui-app-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dbPath = resolve(dir, "telemetry.db");
    seedTelemetryDb(dbPath);
    db = await TelemetryDb.open(dbPath);
    instance = render(<App db={db} />);
    await flush();
  });

  afterEach(() => {
    instance.unmount();
    db.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * @case Root frame renders header, navigation, metrics and footer hints
   * @preconditions Seeded telemetry database with one route
   * @expectedResult Wordmark header, NAVIGATION/METRICS panels, the route id
   *   and footer key hints are all visible
   */
  test("renders the root layout", () => {
    const frame = instance.lastFrame()!;
    expect(frame).toContain("Routecraft");
    expect(frame).toContain("craft tui");
    expect(frame).toContain("NAVIGATION");
    expect(frame).toContain("METRICS");
    expect(frame).toContain("r1");
    expect(frame).toContain("Quit");
  });

  /**
   * @case Number shortcut switches to the Agents tab
   * @preconditions Seeded database with registered and inline agents
   * @expectedResult Agent keys appear in the nav list and the breadcrumb
   *   shows the Agents tab
   */
  test("switches to the Agents tab via shortcut", async () => {
    instance.stdin.write("2");
    await flush();
    const frame = instance.lastFrame()!;
    expect(frame).toContain("researcher");
    expect(frame).toContain("summariser");
    expect(frame).toContain("Agents");
  });

  /**
   * @case Enter drills from agent to runs to run detail to tool I/O
   * @preconditions researcher agent has one run (ex1) with one tool call
   * @expectedResult Each Enter pushes a view: runs list, run detail with
   *   TOOL CALLS timeline, then the tool call INPUT/OUTPUT document
   */
  test("drills into an agent run and tool call", async () => {
    instance.stdin.write("2");
    await flush();
    instance.stdin.write("j");
    await flush();
    instance.stdin.write("j"); // select "researcher" (sorted after r3, r2)
    await flush();
    instance.stdin.write(ENTER); // browse runs of the selected agent
    await flush();
    expect(instance.lastFrame()!).toContain("RUNS:");

    instance.stdin.write(ENTER); // open the run detail
    await flush();
    const runFrame = instance.lastFrame()!;
    expect(runFrame).toContain("TOOL CALLS");
    expect(runFrame).toContain("anthropic:claude-opus-4-7");
    expect(runFrame).toContain("20 in / 10 out");

    instance.stdin.write(ENTER); // open the tool call I/O
    await flush();
    const callFrame = instance.lastFrame()!;
    expect(callFrame).toContain("INPUT");
    expect(callFrame).toContain("OUTPUT");
    expect(callFrame).toContain("hello");
  });

  /**
   * @case Esc pops one view at a time back to the tab root
   * @preconditions Drilled into a tool call from an agent run
   * @expectedResult Esc returns to the run detail, then the runs list,
   *   then the agent nav root
   */
  test("Esc pops the view stack one level at a time", async () => {
    instance.stdin.write("2");
    await flush();
    instance.stdin.write("j");
    await flush();
    instance.stdin.write("j");
    await flush();
    instance.stdin.write(ENTER);
    await flush();
    instance.stdin.write(ENTER);
    await flush();
    instance.stdin.write(ENTER);
    await flush();
    expect(instance.lastFrame()!).toContain("INPUT");

    instance.stdin.write(ESC);
    await flush();
    expect(instance.lastFrame()!).toContain("TOOL CALLS");

    instance.stdin.write(ESC);
    await flush();
    expect(instance.lastFrame()!).toContain("RUNS:");

    instance.stdin.write(ESC);
    await flush();
    // Back at the tab root: footer offers the drill-in hint again
    expect(instance.lastFrame()!).toContain("Runs");
  });

  /**
   * @case Agent runs list surfaces model and tokens at list level
   * @preconditions researcher's run ex1 finished with model and 30 tokens
   * @expectedResult Runs list shows Model and Tokens columns with values
   */
  test("agent runs list shows model and token columns", async () => {
    instance.stdin.write("2");
    await flush();
    instance.stdin.write("j");
    await flush();
    instance.stdin.write("j");
    await flush();
    instance.stdin.write(ENTER);
    await flush();
    const frame = instance.lastFrame()!;
    expect(frame).toContain("Model");
    expect(frame).toContain("Tokens");
    expect(frame).toContain("anthropic");
    expect(frame).toContain("30");
  });

  /**
   * @case Slash filter narrows the browsed list to matching rows
   * @preconditions Exchanges tab browsed with ex1 (completed) and ex2 (failed)
   * @expectedResult Typing /ex2 hides ex1; Esc in typing mode clears the filter
   */
  test("slash filter narrows the exchange list", async () => {
    instance.stdin.write("4"); // Exchanges tab
    await flush();
    instance.stdin.write(ENTER); // browse
    await flush();
    expect(instance.lastFrame()!).toContain("ex1");

    instance.stdin.write("/");
    await flush();
    for (const ch of "ex2") {
      instance.stdin.write(ch);
      await flush();
    }
    let frame = instance.lastFrame()!;
    expect(frame).toContain("/ex2");
    expect(frame).toContain("ex2");
    expect(frame).not.toContain("ex1");

    instance.stdin.write(ESC); // cancel the filter
    await flush();
    frame = instance.lastFrame()!;
    expect(frame).toContain("ex1");
  });

  /**
   * @case Follow mode toggles with f and disengages on cursor movement
   * @preconditions Exchanges tab in browse mode
   * @expectedResult Footer shows the follow indicator after f and hides it after j
   */
  test("follow mode toggles in browse lists", async () => {
    instance.stdin.write("4");
    await flush();
    instance.stdin.write(ENTER);
    await flush();
    instance.stdin.write("f");
    await flush();
    expect(instance.lastFrame()!).toContain("follow");

    instance.stdin.write("j");
    await flush();
    expect(instance.lastFrame()!).not.toContain("follow");
  });

  /**
   * @case Breadcrumb tracks the drill-down path
   * @preconditions Drilled from Agents into a run's tool call
   * @expectedResult Header breadcrumb shows tab, agent, run and tool name
   */
  test("breadcrumb reflects the drill-down", async () => {
    instance.stdin.write("2");
    await flush();
    instance.stdin.write("j");
    await flush();
    instance.stdin.write("j");
    await flush();
    instance.stdin.write(ENTER);
    await flush();
    instance.stdin.write(ENTER);
    await flush();
    const frame = instance.lastFrame()!;
    expect(frame).toContain("Agents");
    expect(frame).toContain("researcher");
    expect(frame).toContain("run ex1");
  });
});
