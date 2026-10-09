import { describe, expect, test } from "bun:test";
import { ContextBuilder, definePlugin } from "@routecraft/routecraft";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The stop walk has one owner: however many exits reach it (an ordinary
 * stop, a failed build, a stop requested from inside a hook or an event
 * observer), each plugin's `stop` and disposers run once.
 */
describe("shutdown ownership", () => {
  /**
   * @case A bind requests a stop and then throws
   * @preconditions Plugin A bound with an async stop and a disposer; plugin B's bind calls c.execution.requestStop() and throws
   * @expectedResult build() rejects with B's error; A's stop and disposer each ran once; the context reports stopped once
   */
  test("a failed build joins the shutdown a bind requested", async () => {
    const log: string[] = [];
    const original = new Error("bind refused");
    let stopped = 0;
    const a = definePlugin({
      id: "test.a",
      bind(c) {
        c.onDispose(() => {
          log.push("dispose");
        });
      },
      async stop() {
        log.push("stop");
        await tick();
      },
    });
    const b = definePlugin({
      id: "test.b",
      bind(c) {
        c.execution.requestStop();
        throw original;
      },
    });
    const finished = Promise.withResolvers<void>();
    const error = await new ContextBuilder()
      .on("context:stopped", () => {
        stopped++;
        finished.resolve();
      })
      .with({ plugins: [a, b] })
      .build()
      .catch((e: unknown) => e);
    await finished.promise;
    await tick();
    expect(error).toBe(original);
    expect(log).toEqual(["stop", "dispose"]);
    expect(stopped).toBe(1);
  });

  /**
   * @case A context:stopping observer calls stop() again
   * @preconditions A bound plugin with an async stop; the observer calls context.stop() once from inside the emit
   * @expectedResult The nested call joins the shutdown in progress: one stopping event, one plugin stop, both calls settle
   */
  test("a reentrant stop from the stopping event joins the one shutdown", async () => {
    let stops = 0;
    let events = 0;
    const nested: Promise<unknown>[] = [];
    const { context } = await new ContextBuilder()
      .with({
        plugins: [
          definePlugin({
            id: "test.resource",
            async stop() {
              stops++;
              await tick();
            },
          }),
        ],
      })
      .build();
    context.on("context:stopping", () => {
      if (++events === 1) nested.push(context.stop());
    });
    const outcome = await context.stop();
    const [again] = await Promise.all(nested);
    expect(stops).toBe(1);
    expect(events).toBe(1);
    expect(again).toBe(outcome);
  });

  /**
   * @case Ordinary concurrent stop() calls
   * @preconditions A bound plugin; twenty stop() calls issued without awaiting between them
   * @expectedResult One plugin stop; every call resolves to the same outcome
   */
  test("concurrent stop() calls share one walk", async () => {
    let stops = 0;
    const { context } = await new ContextBuilder()
      .with({
        plugins: [
          definePlugin({
            id: "test.resource",
            async stop() {
              stops++;
              await tick();
            },
          }),
        ],
      })
      .build();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => context.stop()),
    );
    expect(stops).toBe(1);
    expect(new Set(outcomes).size).toBe(1);
  });
});
