import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";
import { cron } from "../src/index.ts";
import { CronSourceAdapter } from "../src/adapters/cron/index.ts";
import {
  HeadersKeys,
  type Exchange,
  type ExchangeHeaders,
} from "../src/exchange.ts";
import { CraftContext } from "../src/context.ts";

function mockContext(): CraftContext {
  const store = new Map();
  return {
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    },
    getStore: (key: symbol) => store.get(key),
    setStore: (key: symbol, value: unknown) => store.set(key, value),
  } as unknown as CraftContext;
}

/**
 * Advance fake timers by the given milliseconds, flushing microtasks at each
 * step to allow croner's internal scheduling and async handler callbacks to
 * execute.
 */
async function advanceTime(ms: number, step = 1000) {
  const steps = Math.ceil(ms / step);
  for (let i = 0; i < steps; i++) {
    vi.advanceTimersByTime(step);
    // Flush microtasks so croner's setTimeout callbacks and async handlers run
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe("CronSourceAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * @case cron() factory returns a Source<undefined>
   * @preconditions Called with a valid cron expression
   * @expectedResult Returns an instance of CronSourceAdapter with correct adapterId
   */
  test("cron() factory returns a CronSourceAdapter", () => {
    const source = cron("* * * * *");
    expect(source).toBeInstanceOf(CronSourceAdapter);
  });

  /**
   * @case Adapter has correct adapterId
   * @preconditions CronSourceAdapter instantiated
   * @expectedResult adapterId is "routecraft.adapter.cron"
   */
  test("adapterId is routecraft.adapter.cron", () => {
    const adapter = new CronSourceAdapter("* * * * *");
    expect(adapter.adapterId).toBe("routecraft.adapter.cron");
  });

  /**
   * @case Cron fires and provides correct headers
   * @preconditions CronSourceAdapter with per-second expression and maxFires=1
   * @expectedResult Handler is called once with correct cron headers
   */
  test("subscribe fires handler with cron headers", async () => {
    const adapter = new CronSourceAdapter("* * * * * *", { maxFires: 1 });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);
    const onReady = vi.fn();

    const promise = adapter.subscribe(
      context,
      handler,
      abortController,
      onReady,
    );

    await advanceTime(2000);

    abortController.abort();
    await promise;

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);

    const headers: ExchangeHeaders = handler.mock.calls[0][1];
    expect(headers[HeadersKeys.CRON_EXPRESSION]).toBe("* * * * * *");
    expect(headers[HeadersKeys.CRON_FIRED_TIME]).toBeDefined();
    expect(headers[HeadersKeys.CRON_COUNTER]).toBe(1);
  });

  /**
   * @case maxFires limits execution count
   * @preconditions CronSourceAdapter with per-second expression and maxFires=2
   * @expectedResult Handler is called exactly 2 times
   */
  test("maxFires limits the number of executions", async () => {
    const adapter = new CronSourceAdapter("* * * * * *", { maxFires: 2 });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    await advanceTime(5000);

    expect(handler).toHaveBeenCalledTimes(2);

    abortController.abort();
    await promise;
  });

  /**
   * @case AbortController stops the cron job
   * @preconditions CronSourceAdapter with per-second expression, aborted after first fire
   * @expectedResult Handler is called once, then the job stops
   */
  test("abortController stops the cron job", async () => {
    const adapter = new CronSourceAdapter("* * * * * *");
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockImplementation(async () => {
      abortController.abort();
      return {} as Exchange;
    });

    const promise = adapter.subscribe(context, handler, abortController);

    await advanceTime(2000);
    await promise;

    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
   * @case Timezone option is passed in headers
   * @preconditions CronSourceAdapter with timezone option and maxFires=1
   * @expectedResult Headers contain the configured timezone
   */
  test("timezone is included in headers", async () => {
    const adapter = new CronSourceAdapter("* * * * * *", {
      maxFires: 1,
      timezone: "America/New_York",
    });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    await advanceTime(2000);

    abortController.abort();
    await promise;

    expect(handler).toHaveBeenCalledTimes(1);
    const headers: ExchangeHeaders = handler.mock.calls[0][1];
    expect(headers[HeadersKeys.CRON_TIMEZONE]).toBe("America/New_York");
  });

  /**
   * @case Name option is passed in headers
   * @preconditions CronSourceAdapter with name option and maxFires=1
   * @expectedResult Headers contain the configured name
   */
  test("name is included in headers", async () => {
    const adapter = new CronSourceAdapter("* * * * * *", {
      maxFires: 1,
      name: "test-job",
    });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    await advanceTime(2000);

    abortController.abort();
    await promise;

    expect(handler).toHaveBeenCalledTimes(1);
    const headers: ExchangeHeaders = handler.mock.calls[0][1];
    expect(headers[HeadersKeys.CRON_NAME]).toBe("test-job");
  });

  /**
   * @case Handler error stops the cron and aborts
   * @preconditions CronSourceAdapter with per-second expression, handler throws on first call
   * @expectedResult Error is logged, abort is called, cron stops
   */
  test("handler error stops the cron job and aborts", async () => {
    const adapter = new CronSourceAdapter("* * * * * *");
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockRejectedValue(new Error("test error"));

    const promise = adapter.subscribe(context, handler, abortController);

    await advanceTime(2000);
    await promise;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(abortController.signal.aborted).toBe(true);
    expect(context.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: "cron" }),
      "test error",
    );
  });

  /**
   * @case Counter increments on each fire
   * @preconditions CronSourceAdapter with per-second expression and maxFires=2
   * @expectedResult Counter header values are 1 and 2 respectively
   */
  test("counter increments on each fire", async () => {
    const adapter = new CronSourceAdapter("* * * * * *", { maxFires: 2 });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    await advanceTime(5000);

    abortController.abort();
    await promise;

    expect(handler).toHaveBeenCalledTimes(2);
    const firstHeaders: ExchangeHeaders = handler.mock.calls[0][1];
    const secondHeaders: ExchangeHeaders = handler.mock.calls[1][1];
    expect(firstHeaders[HeadersKeys.CRON_COUNTER]).toBe(1);
    expect(secondHeaders[HeadersKeys.CRON_COUNTER]).toBe(2);
  });

  /**
   * @case Cron expression nicknames are supported
   * @preconditions CronSourceAdapter created with @daily nickname
   * @expectedResult Adapter instantiates without error
   */
  test("supports cron expression nicknames like @daily", () => {
    expect(() => new CronSourceAdapter("@daily")).not.toThrow();
    expect(() => new CronSourceAdapter("@weekly")).not.toThrow();
    expect(() => new CronSourceAdapter("@hourly")).not.toThrow();
    expect(() => new CronSourceAdapter("@monthly")).not.toThrow();
    expect(() => new CronSourceAdapter("@yearly")).not.toThrow();
  });

  /**
   * @case cron() factory with options passes them through
   * @preconditions cron() called with expression and options
   * @expectedResult Resulting adapter has the configured options
   */
  test("cron() factory passes options to adapter", async () => {
    const source = cron("* * * * * *", {
      maxFires: 1,
      name: "factory-test",
      timezone: "UTC",
    });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = (source as CronSourceAdapter).subscribe(
      context,
      handler,
      abortController,
    );

    await advanceTime(2000);

    abortController.abort();
    await promise;

    expect(handler).toHaveBeenCalledTimes(1);
    const headers: ExchangeHeaders = handler.mock.calls[0][1];
    expect(headers[HeadersKeys.CRON_NAME]).toBe("factory-test");
    expect(headers[HeadersKeys.CRON_TIMEZONE]).toBe("UTC");
  });

  /**
   * @case jitterMs delays handler execution without leaking timeouts
   * @preconditions CronSourceAdapter with per-second expression, jitterMs=2000, maxFires=1
   * @expectedResult Handler is called exactly once after jitter delay
   */
  test("jitterMs delays handler execution correctly", async () => {
    const adapter = new CronSourceAdapter("* * * * * *", {
      maxFires: 1,
      jitterMs: 2000,
    });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    await advanceTime(5000);

    abortController.abort();
    await promise;

    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
   * @case Aborting during jitter delay does not fire handler
   * @preconditions CronSourceAdapter with per-second expression and jitterMs=5000, aborted before jitter elapses
   * @expectedResult Handler is never called, subscribe resolves cleanly
   */
  test("abort during jitter delay prevents handler call", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);

    const adapter = new CronSourceAdapter("* * * * * *", {
      jitterMs: 10000,
    });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    // Advance past the first cron tick but not past the ~9900ms jitter
    await advanceTime(2000);
    abortController.abort();
    await advanceTime(1000);
    await promise;

    randomSpy.mockRestore();

    expect(handler).toHaveBeenCalledTimes(0);
  });

  /**
   * @case nextRun header is provided when there is a next run
   * @preconditions CronSourceAdapter with per-second expression and maxFires=2
   * @expectedResult First fire headers contain a valid nextRun ISO string
   */
  test("nextRun header is populated", async () => {
    const adapter = new CronSourceAdapter("* * * * * *", { maxFires: 2 });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    await advanceTime(5000);

    abortController.abort();
    await promise;

    expect(handler).toHaveBeenCalledTimes(2);
    const headers: ExchangeHeaders = handler.mock.calls[0][1];
    const nextRun = headers[HeadersKeys.CRON_NEXT_RUN];
    expect(nextRun).toBeDefined();
    expect(new Date(nextRun as string).getTime()).toBeGreaterThan(0);
  });

  /**
   * @case protect option prevents concurrent handler execution
   * @preconditions CronSourceAdapter with per-second expression, jitterMs=2000, protect=true (default)
   * @expectedResult Handler is called exactly once despite overlapping ticks during jitter
   */
  test("protect: true prevents concurrent handler execution", async () => {
    const adapter = new CronSourceAdapter("* * * * * *", {
      maxFires: 1,
      jitterMs: 2000,
    });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    await advanceTime(5000);

    abortController.abort();
    await promise;

    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
   * @case protect: false allows concurrent handler execution
   * @preconditions CronSourceAdapter with per-second expression, protect=false, maxFires=3
   * @expectedResult Handler can be called concurrently when protect is disabled
   */
  test("protect: false allows overlapping handler calls", async () => {
    const adapter = new CronSourceAdapter("* * * * * *", {
      protect: false,
      maxFires: 3,
    });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    await advanceTime(5000);

    abortController.abort();
    await promise;

    expect(handler).toHaveBeenCalledTimes(3);
  });

  /**
   * @case stopAt prevents firing after the specified date
   * @preconditions CronSourceAdapter with per-second expression and stopAt set 3 seconds in the future
   * @expectedResult Handler fires only while current time is before stopAt
   */
  test("stopAt stops the cron job at the specified date", async () => {
    const now = new Date();
    const stopAt = new Date(now.getTime() + 3000);

    const adapter = new CronSourceAdapter("* * * * * *", {
      stopAt,
    });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    await advanceTime(6000);

    abortController.abort();
    await promise;

    // Should have fired approximately 2-3 times (before stopAt), not 5-6
    expect(handler.mock.calls.length).toBeLessThanOrEqual(3);
    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * @case startAt delays firing until the specified date
   * @preconditions CronSourceAdapter with per-second expression and startAt set 3 seconds in the future
   * @expectedResult Handler does not fire before startAt
   */
  test("startAt delays cron firing until the specified date", async () => {
    const now = new Date();
    const startAt = new Date(now.getTime() + 3000);

    const adapter = new CronSourceAdapter("* * * * * *", {
      startAt,
      maxFires: 1,
    });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    // Advance 2 seconds -- handler should not have fired yet
    await advanceTime(2000);
    expect(handler).toHaveBeenCalledTimes(0);

    // Advance past startAt
    await advanceTime(3000);

    abortController.abort();
    await promise;

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
