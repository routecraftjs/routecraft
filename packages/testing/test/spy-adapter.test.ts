import { describe, test, expect, afterEach } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple } from "@routecraft/routecraft";
import type { Exchange } from "@routecraft/routecraft";

function mockExchange<T>(body: T, operation?: string): Exchange<T> {
  return {
    id: "test-id",
    body,
    headers: {
      "routecraft.operation": operation ?? "to",
    },
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      trace: () => {},
      fatal: () => {},
      level: "info",
      silent: false,
      msgPrefix: "",
    },
  } as unknown as Exchange<T>;
}

describe("SpyAdapter", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case send() records exchange and increments calls.send
   * @preconditions SpyAdapter created with spy()
   * @expectedResult received has one entry, calls.send is 1
   */
  test("send() records exchange and increments calls.send", () => {
    const s = spy();
    const exchange = mockExchange("hello");

    s.send(exchange);

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toBe("hello");
    expect(s.calls.send).toBe(1);
    expect(s.calls.process).toBe(0);
    expect(s.calls.enrich).toBe(0);
  });

  /**
   * @case process() records exchange and returns it unchanged
   * @preconditions SpyAdapter created with spy()
   * @expectedResult received has one entry, calls.process is 1, exchange is returned
   */
  test("process() records exchange, increments calls.process, returns exchange", () => {
    const s = spy();
    const exchange = mockExchange({ name: "test" });

    const result = s.process(exchange);

    expect(result).toBe(exchange);
    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({ name: "test" });
    expect(s.calls.process).toBe(1);
    expect(s.calls.send).toBe(0);
  });

  /**
   * @case send() via enrich increments calls.enrich
   * @preconditions SpyAdapter receives exchange with routecraft.operation header set to "enrich"
   * @expectedResult calls.enrich is 1, calls.send is 0
   */
  test("send() with enrich operation header increments calls.enrich", () => {
    const s = spy();
    const exchange = mockExchange("data", "enrich");

    s.send(exchange);

    expect(s.calls.enrich).toBe(1);
    expect(s.calls.send).toBe(0);
    expect(s.received).toHaveLength(1);
  });

  /**
   * @case receivedBodies() returns array of body values
   * @preconditions SpyAdapter has received multiple exchanges
   * @expectedResult Array of body values in order
   */
  test("receivedBodies() returns array of body values", () => {
    const s = spy<string>();
    s.send(mockExchange("a"));
    s.send(mockExchange("b"));
    s.send(mockExchange("c"));

    expect(s.receivedBodies()).toEqual(["a", "b", "c"]);
  });

  /**
   * @case lastReceived() returns the most recent exchange
   * @preconditions SpyAdapter has received multiple exchanges
   * @expectedResult Returns the last exchange
   */
  test("lastReceived() returns the most recent exchange", () => {
    const s = spy<string>();
    s.send(mockExchange("first"));
    s.send(mockExchange("second"));

    expect(s.lastReceived().body).toBe("second");
  });

  /**
   * @case lastReceived() throws when no exchanges recorded
   * @preconditions SpyAdapter has not received any exchanges
   * @expectedResult Throws an error
   */
  test("lastReceived() throws when no exchanges recorded", () => {
    const s = spy();

    expect(() => s.lastReceived()).toThrow("no exchanges recorded");
  });

  /**
   * @case reset() clears received and all counters
   * @preconditions SpyAdapter has received exchanges via send and process
   * @expectedResult received is empty, all counters are 0
   */
  test("reset() clears received and all counters", () => {
    const s = spy();
    s.send(mockExchange("a"));
    s.send(mockExchange("b", "enrich"));
    s.process(mockExchange("c"));

    s.reset();

    expect(s.received).toHaveLength(0);
    expect(s.calls.send).toBe(0);
    expect(s.calls.process).toBe(0);
    expect(s.calls.enrich).toBe(0);
  });

  /**
   * @case Integration with testContext and route pipeline
   * @preconditions Route with simple source and spy destination built via testContext
   * @expectedResult spy records the exchange from the pipeline
   */
  test("works end-to-end with testContext", async () => {
    const s = spy<string>();

    t = await testContext()
      .routes(craft().id("spy-test").from(simple("payload")).to(s))
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toBe("payload");
    expect(s.calls.send).toBe(1);
  });

  /**
   * @case Multiple spies in one route track independently
   * @preconditions Route with spy as processor and spy as destination
   * @expectedResult Each spy records independently with correct call counters
   */
  test("multiple spies in one route track independently", async () => {
    const processSpy = spy<string>();
    const destSpy = spy<string>();

    t = await testContext()
      .routes(
        craft()
          .id("multi-spy")
          .from(simple("input"))
          .process(processSpy)
          .to(destSpy),
      )
      .build();

    await t.test();

    expect(processSpy.calls.process).toBe(1);
    expect(processSpy.received[0].body).toBe("input");
    expect(destSpy.calls.send).toBe(1);
    expect(destSpy.received[0].body).toBe("input");
  });
});
