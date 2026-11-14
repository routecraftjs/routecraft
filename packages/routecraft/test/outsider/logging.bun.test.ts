import { describe, expect, test } from "bun:test";
import {
  ContextBuilder,
  craft,
  defineProject,
  direct,
  type LogBindings,
  type Logger,
  type LogLevel,
} from "@routecraft/routecraft";

interface Line {
  level: LogLevel;
  bindings: LogBindings;
  fields: LogBindings;
  message: string;
}

/** A logger of the application's own: every line of it and of its children, kept. */
function capturing(lines: Line[], bindings: LogBindings = {}): Logger {
  const at =
    (level: LogLevel) =>
    (first: LogBindings | string, second?: string): void => {
      lines.push({
        level,
        bindings,
        fields: typeof first === "string" ? {} : first,
        message: typeof first === "string" ? first : (second ?? ""),
      });
    };
  return {
    child: (more) => capturing(lines, { ...bindings, ...more }),
    isLevelEnabled: () => true,
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    fatal: at("fatal"),
  };
}

/** Run one message through the routes of a project and stop. */
async function send(
  project: ReturnType<typeof defineProject>,
  routes: Parameters<ContextBuilder["routes"]>[0],
  body: unknown,
): Promise<unknown> {
  const { context, client } = await new ContextBuilder()
    .with(project.config)
    .routes(routes)
    .build();
  const running = context.start();
  try {
    await context.whenStarted();
    return await client.sendDirect("seen", body);
  } finally {
    await context.stop();
    await running;
  }
}

describe("logging from the published packages", () => {
  /**
   * @case An application hands its own logger to the project and logs from inside a route
   * @preconditions A capturing `Logger` as `defineProject({ logger })`; a route with `.log()` between two `.process()` steps
   * @expectedResult The line lands between the two steps, carries the exchange's id and the route's id through the child bindings, keeps its message and fields, and the body the second step sees is the object the first one produced
   */
  test("a .log() line is written in the flow, on the exchange", async () => {
    const lines: Line[] = [];
    const order: string[] = [];
    const seen: { id?: string; first?: object; second?: object } = {};
    const project = defineProject({ logger: capturing(lines) });

    await send(
      project,
      project
        .craft()
        .id("seen")
        .from(direct<{ n: number }>())
        .process((ex) => {
          order.push("a");
          seen.id = ex.id;
          seen.first = ex.body;
          return ex;
        })
        .log("info", "Seen", (ex) => {
          order.push("log");
          return { n: ex.body.n };
        })
        .process((ex) => {
          order.push("b");
          seen.second = ex.body;
          return ex;
        }),
      { n: 1 },
    );

    expect(order).toEqual(["a", "log", "b"]);
    expect(seen.second).toBe(seen.first);
    const line = lines.find((entry) => entry.message === "Seen");
    expect(line).toMatchObject({
      level: "info",
      fields: { n: 1 },
      bindings: { exchangeId: seen.id, route: "seen" },
    });
    expect(line?.bindings["contextId"]).toBeString();
  });

  /**
   * @case The level of a line is chosen from the exchange
   * @preconditions A `.log()` whose level is a function of the body, sent a quiet body and a loud one
   * @expectedResult One line at debug and one at warn, both with the fixed message
   */
  test("a level function picks the level per exchange", async () => {
    const lines: Line[] = [];
    const project = defineProject({ logger: capturing(lines) });
    const routes = project
      .craft()
      .id("seen")
      .from(direct<{ n: number }>())
      .log((ex) => (ex.body.n > 9 ? "warn" : "debug"), "Counted");

    await send(project, routes, { n: 1 });
    await send(project, routes, { n: 10 });

    expect(
      lines
        .filter((entry) => entry.message === "Counted")
        .map((entry) => entry.level),
    ).toEqual(["debug", "warn"]);
  });

  /**
   * @case The bindings of a line throw, or try to change the exchange
   * @preconditions One route whose bindings throw and one whose bindings write to the body
   * @expectedResult Each gives exactly one warn naming the line, the route completes with the body untouched, and the line itself is not written
   */
  test("a line that cannot be built costs the line, never the exchange", async () => {
    for (const bindings of [
      (): LogBindings => {
        throw new Error("no such field");
      },
      (ex: { readonly body: { n: number } }): LogBindings => {
        (ex.body as { n: number }).n = 2;
        return {};
      },
    ]) {
      const lines: Line[] = [];
      const project = defineProject({ logger: capturing(lines) });

      const answer = await send(
        project,
        project
          .craft()
          .id("seen")
          .from(direct<{ n: number }>())
          .log("info", "Seen", bindings)
          .transform((body) => body.n),
        { n: 1 },
      );

      expect(answer).toBe(1);
      expect(lines.some((entry) => entry.message === "Seen")).toBe(false);
      const warned = lines.filter(
        (entry) => entry.message === "Log line could not be built",
      );
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatchObject({
        level: "warn",
        fields: { line: "Seen" },
      });
      expect(warned[0]?.fields["err"]).toBeInstanceOf(Error);
    }
  });

  /**
   * @case What the 0.7 logging surface left behind
   * @preconditions The published types of the main entry and of a route builder
   * @expectedResult There is no `logger` export, no `log` or `debug` adapter, no `.debug()` step, and `.log()` takes no `error` level
   */
  test("the old surface is gone from the types", () => {
    type Core = typeof import("@routecraft/routecraft");
    type Has<K extends string> = K extends keyof Core ? true : false;
    const exported: [Has<"logger">, Has<"log">, Has<"debug">] = [
      false,
      false,
      false,
    ];
    const builder = craft().id("typed").from(direct<{ n: number }>());
    type HasDebug = "debug" extends keyof typeof builder ? true : false;
    const debug: HasDebug = false;
    // @ts-expect-error a failure is logged once, at the boundary: a step has no "error" level.
    builder.log("error", "Never");

    expect([...exported, debug]).toEqual([false, false, false, false]);
  });
});
