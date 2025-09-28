import { describe, test, expect } from "vitest";
import { InMemoryProcessingQueue } from "../src/queue.ts";

describe("InMemoryProcessingQueue", () => {
  /**
   * @case Buffers messages enqueued before handler and flushes them in order when handler is set
   * @preconditions No handler set; two messages enqueued
   * @expectedResult Handler receives ["a", "b"] in order after being set
   */
  test("buffers messages enqueued before handler is set and flushes in order", async () => {
    const q = new InMemoryProcessingQueue<string>();

    await q.enqueue("a");
    await q.enqueue("b");

    const seen: string[] = [];
    await q.setHandler(async (m) => {
      seen.push(m);
    });

    // Give time for async flush
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual(["a", "b"]);
  });

  /**
   * @case Delivers messages enqueued after handler is set immediately to the handler
   * @preconditions Handler set; two messages enqueued
   * @expectedResult Handler receives [1, 2]
   */
  test("delivers messages enqueued after handler is set", async () => {
    const q = new InMemoryProcessingQueue<number>();
    const seen: number[] = [];
    await q.setHandler(async (m) => {
      seen.push(m);
    });

    await q.enqueue(1);
    await q.enqueue(2);

    expect(seen).toEqual([1, 2]);
  });

  /**
   * @case Clearing removes handler and buffer; subsequent enqueues are buffered until a new handler is set
   * @preconditions Handler set, one message enqueued then queue cleared
   * @expectedResult Only first message delivered; second remains buffered until a new handler is set
   */
  test("clear removes handler and buffer", async () => {
    const q = new InMemoryProcessingQueue<string>();
    const seen: string[] = [];
    await q.setHandler(async (m) => {
      seen.push(m);
    });

    await q.enqueue("x");
    await q.clear();
    await q.enqueue("y");

    // Only the first message delivered before clear should be seen
    expect(seen).toEqual(["x"]);
  });
});
