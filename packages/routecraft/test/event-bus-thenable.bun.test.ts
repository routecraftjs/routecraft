import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/event-bus.ts";

/**
 * An event handler may return any thenable, not only a `Promise`. The bus
 * has to adapt one before reaching for `catch`, which a bare thenable does
 * not carry.
 */
describe("EventBus with a thenable handler result", () => {
  /** Assimilating a thenable costs several microtasks, so yield the loop. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** The two methods the bus calls; its logger type is module-local. */
  const collectingLogger = (messages: string[]) => {
    const record = (_fields: unknown, message?: string) => {
      messages.push(message ?? "");
    };
    return { warn: record, error: record };
  };

  /**
   * @case A handler returning a bare thenable is not reported as throwing
   * @preconditions Handler returns an object with a callable then and no catch, and resolves normally
   * @expectedResult Nothing is logged, because the handler neither threw nor rejected
   */
  test("does not report a returned bare thenable as a throw", async () => {
    const messages: string[] = [];
    const bus = new EventBus("test", collectingLogger(messages));

    bus.on(
      "context:error" as never,
      (() => ({
        then: (resolve: (value: unknown) => void) => resolve(undefined),
      })) as never,
    );
    bus.emit("context:error" as never, { error: new Error("x") } as never);
    await settle();

    expect(messages).toEqual([]);
  });

  /**
   * @case A bare thenable that rejects is still caught and logged
   * @preconditions Handler returns an object with a callable then that invokes its reject callback
   * @expectedResult The rejection is logged as a rejection, so adapting the thenable did not cost the error path
   */
  test("still catches a bare thenable that rejects", async () => {
    const messages: string[] = [];
    const bus = new EventBus("test", collectingLogger(messages));

    bus.on(
      "context:error" as never,
      (() => ({
        then: (_resolve: unknown, reject: (reason: unknown) => void) =>
          reject(new Error("rejected")),
      })) as never,
    );
    bus.emit("context:error" as never, { error: new Error("x") } as never);
    await settle();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Async event handler rejected");
  });
});
