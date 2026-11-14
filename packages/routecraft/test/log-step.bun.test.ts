import { afterEach, describe, expect, test } from "bun:test";
import { pino } from "pino";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  ContextBuilder,
  IDENTITY,
  craft,
  direct,
  noop,
  simple,
  step,
  type Logger,
} from "../src/index.ts";
import { describeSteps } from "../src/internal.ts";
import { readonlyExchange } from "../src/kernel/readonly.ts";

describe(".log()", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A line without bindings
   * @preconditions A route with `.log("info", "Seen")` ahead of a spy destination
   * @expectedResult The route logger gets the message alone, and the destination gets the unchanged body
   */
  test("writes the message alone when there are no bindings", async () => {
    const sink = spy<string>();
    t = await testContext()
      .routes(
        craft().id("plain").from(simple("hello")).log("info", "Seen").to(sink),
      )
      .build();

    await t.test();

    expect(t.logger.info.mock.calls).toContainEqual(["Seen"]);
    expect(sink.receivedBodies()).toEqual(["hello"]);
  });

  /**
   * @case The step events of a log line
   * @preconditions A route with one `.log()`, listening for step events
   * @expectedResult One started and one completed event with operation "log", on the exchange that reaches the destination
   */
  test("emits step events as operation log, on the same exchange", async () => {
    const sink = spy<string>();
    const events: Array<{ name: string; exchangeId: unknown }> = [];
    t = await testContext()
      .routes(
        craft().id("events").from(simple("x")).log("info", "Seen").to(sink),
      )
      .build();
    for (const name of [
      "route:step:started",
      "route:step:completed",
    ] as const) {
      t.ctx.on(name, ({ details }) => {
        if (details.operation === "log") {
          events.push({ name, exchangeId: details.exchangeId });
        }
      });
    }

    await t.test();

    expect(events.map((event) => event.name)).toEqual([
      "route:step:started",
      "route:step:completed",
    ]);
    expect(events[0]?.exchangeId).toBe(sink.received[0]?.id);
    expect(events[1]?.exchangeId).toBe(sink.received[0]?.id);
  });

  /**
   * @case A level the logger does not write
   * @preconditions A pino root at `warn`, and a `.log("debug", ...)` whose bindings count their calls
   * @expectedResult The bindings never run: a line nobody reads costs nothing to build
   */
  test("skips the bindings when the level is off", async () => {
    let built = 0;
    const { context, client } = await new ContextBuilder()
      .with({ logger: pino({ level: "warn" }, { write: () => {} }) })
      .routes(
        craft()
          .id("quiet")
          .from(direct())
          .log("debug", "Seen", () => {
            built += 1;
            return {};
          })
          .to(noop()),
      )
      .build();
    const running = context.start();
    try {
      await context.whenStarted();
      await client.sendDirect("quiet", {});
    } finally {
      await context.stop();
      await running;
    }

    expect(built).toBe(0);
  });

  /**
   * @case A level function hands back something that is no step level
   * @preconditions An untyped caller whose level function returns "error"
   * @expectedResult One warn that the line could not be built, and no line at error
   */
  test("refuses a level outside trace to warn at runtime", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("wrong-level")
          .from(simple("x"))
          .log((() => "error") as unknown as () => "warn", "Seen")
          .to(noop()),
      )
      .build();

    await t.test();

    expect(t.logger.error.mock.calls).toEqual([]);
    const warned = t.logger.warn.mock.calls.filter(
      (call) => call[1] === "Log line could not be built",
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]?.[0]).toMatchObject({ line: "Seen" });
  });

  /**
   * @case The logger itself throws, on the line and on the warn about it
   * @preconditions A root logger that throws on the step's own line and on the warn about it, against the contract that a logger never throws
   * @expectedResult The exchange still reaches the destination with its body
   */
  test("a logger that throws does not cost the exchange", async () => {
    const boom = (first: unknown, second?: unknown): void => {
      const message = typeof first === "string" ? first : second;
      if (message === "Seen" || message === "Log line could not be built") {
        throw new Error("the sink is gone");
      }
    };
    const broken: Logger = {
      child: () => broken,
      isLevelEnabled: () => true,
      trace: () => {},
      debug: () => {},
      info: boom,
      warn: boom,
      error: () => {},
      fatal: () => {},
    };
    const { context, client } = await new ContextBuilder()
      .with({ logger: broken })
      .routes(
        craft()
          .id("broken-logger")
          .from(direct<{ n: number }>())
          .log("info", "Seen")
          .transform((body) => body.n + 1),
      )
      .build();
    const running = context.start();
    let answer: unknown;
    try {
      await context.whenStarted();
      answer = await client.sendDirect("broken-logger", { n: 1 });
    } finally {
      await context.stop();
      await running;
    }

    expect(answer).toBe(2);
  });

  /**
   * @case A pino logger is the root, with no adapter
   * @preconditions `pino()` assigned to a `Logger`, as `CraftConfig.logger`, writing to a buffer; one `.log()` with the exchange's headers
   * @expectedResult The NDJSON line carries the message, the route, the exchange id and the bindings
   */
  test("pino satisfies Logger as it is", async () => {
    const written: string[] = [];
    const root: Logger = pino(
      { level: "info" },
      { write: (line: string) => written.push(line) },
    );
    const { context, client } = await new ContextBuilder()
      .with({ logger: root })
      .routes(
        craft()
          .id("pino")
          .from(direct<{ n: number }>())
          .log("info", "Seen", (ex) => ({ n: ex.body.n, body: ex.body }))
          .to(noop()),
      )
      .build();
    const running = context.start();
    try {
      await context.whenStarted();
      await client.sendDirect("pino", { n: 7 });
    } finally {
      await context.stop();
      await running;
    }

    const line = written
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .find((entry) => entry["msg"] === "Seen");
    expect(line).toMatchObject({ route: "pino", n: 7, body: { n: 7 } });
    expect(line?.["exchangeId"]).toBeString();
    expect(line?.["contextId"]).toBe(context.contextId);
  });
});

describe(".log() and the continuation digest", () => {
  const stepsOf = (
    build: (route: ReturnType<ReturnType<typeof craft>["from"]>) => {
      build(): Array<{ steps: unknown[] }>;
    },
  ) => build(craft().id("digest").from(direct())).build()[0]!.steps as never;

  /**
   * @case A log line is reworded, or added, behind a deferral
   * @preconditions The same tail with no log line, with one, and with one of another level, message and bindings
   * @expectedResult All three digest the same, so the edit refuses no parked exchange
   */
  test("editing a log line does not move the digest", () => {
    const bare = describeSteps(stepsOf((r) => r.to(noop()))).digest;
    const logged = describeSteps(
      stepsOf((r) => r.log("info", "Seen").to(noop())),
    ).digest;
    const reworded = describeSteps(
      stepsOf((r) =>
        r.log("warn", "Seen again", (ex) => ({ id: ex.id })).to(noop()),
      ),
    ).digest;

    expect(logged).toBe(bare);
    expect(reworded).toBe(bare);
  });

  /**
   * @case A step of someone else's that calls itself "log"
   * @preconditions A raw step labelled `log` with an identity of its own, at two versions
   * @expectedResult The digest moves with the version: the exemption belongs to core's log step, not to the label
   */
  test("a third-party step labelled log is not exempt", () => {
    const labelled = (version: number) => {
      const mine = step((ex) => ex.body, {
        identity: { version },
      });
      return describeSteps([
        Object.assign(mine, {
          label: "log",
          [IDENTITY]: () => ({ kind: "acme.log", version }),
        }),
      ] as never).digest;
    };

    expect(labelled(1)).not.toBe(labelled(2));
    expect(labelled(1)).not.toBe(describeSteps([] as never).digest);
  });
});

describe("the read-only exchange view", () => {
  const exchange = () =>
    Object.freeze({
      id: "ex-1",
      headers: Object.freeze({ authorization: "Bearer secret", plain: "yes" }),
      body: {
        order: { lines: [{ sku: "a" }] },
        at: new Date(0),
        tags: new Map([["k", "v"]]),
      },
    });

  /**
   * @case Writes through the view
   * @preconditions A frozen exchange whose body is not frozen
   * @expectedResult A write to the body, to an object inside it, to an array inside it and a delete are each refused with RC1110, and the real body is unchanged
   */
  test("refuses every write to the plain graph", () => {
    const real = exchange();
    const view = readonlyExchange(real, ".log()");
    const writes = [
      () => ((view.body as { order: unknown }).order = {}),
      () => ((view.body.order.lines[0] as { sku: string }).sku = "b"),
      () => view.body.order.lines.push({ sku: "c" }),
      () => delete (view.body as { order?: unknown }).order,
    ];

    for (const write of writes) {
      expect(write).toThrow(expect.objectContaining({ rc: "RC1110" }));
    }
    expect(real.body.order.lines).toEqual([{ sku: "a" }]);
  });

  /**
   * @case Reads through the view
   * @preconditions The same exchange, read the ways a bindings function reads one
   * @expectedResult Property reads, spreads, `Object.keys`, array methods and JSON all see the real values, and an array is still an array
   */
  test("reads like the exchange it views", () => {
    const real = exchange();
    const view = readonlyExchange(real, ".log()");

    expect(view.id).toBe("ex-1");
    expect({ ...view.headers }).toEqual({ ...real.headers });
    expect(Object.keys(view.body)).toEqual(["order", "at", "tags"]);
    expect(Array.isArray(view.body.order.lines)).toBe(true);
    expect(view.body.order.lines.map((line) => line.sku)).toEqual(["a"]);
    expect(JSON.stringify(view.body.order)).toBe('{"lines":[{"sku":"a"}]}');
    expect(readonlyExchange(real, ".log()")).toBe(view);
  });

  /**
   * @case Class instances in the body
   * @preconditions A `Date` and a `Map` in the body
   * @expectedResult Both are handed out as they are, so their methods run: an instance cannot be viewed, only trusted
   */
  test("hands a class instance out as it is", () => {
    const real = exchange();
    const view = readonlyExchange(real, ".log()");

    expect(view.body.at).toBe(real.body.at);
    expect(view.body.at.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(view.body.tags.get("k")).toBe("v");
  });
});
