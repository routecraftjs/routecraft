import { describe, test, expect, vi, afterEach } from "vitest";
import { cron } from "../src/index.ts";
import { CronSourceAdapter } from "../src/adapters/cron/index.ts";
import {
  HeadersKeys,
  type Exchange,
  type ExchangeHeaders,
} from "../src/exchange.ts";
import { CraftContext } from "../src/context.ts";

function mockContext(): CraftContext {
  return {
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    },
  } as unknown as CraftContext;
}

describe("CronSourceAdapter", () => {
  afterEach(() => {
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

    // Wait for the cron to fire (every second)
    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );

    // Clean up
    abortController.abort();
    await promise;

    expect(onReady).toHaveBeenCalledTimes(1);

    const headers: ExchangeHeaders = handler.mock.calls[0][1];
    expect(headers[HeadersKeys.CRON_EXPRESSION]).toBe("* * * * * *");
    expect(headers[HeadersKeys.CRON_FIRED_TIME]).toBeDefined();
    expect(headers[HeadersKeys.CRON_COUNTER]).toBe(1);
  }, 5000);

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

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(2);
      },
      { timeout: 5000 },
    );

    // Give it a moment to ensure it stops
    await new Promise((r) => setTimeout(r, 1500));
    expect(handler).toHaveBeenCalledTimes(2);

    abortController.abort();
    await promise;
  }, 10000);

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

    await adapter.subscribe(context, handler, abortController);

    expect(handler).toHaveBeenCalledTimes(1);
  }, 5000);

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

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );

    abortController.abort();
    await promise;

    const headers: ExchangeHeaders = handler.mock.calls[0][1];
    expect(headers[HeadersKeys.CRON_TIMEZONE]).toBe("America/New_York");
  }, 5000);

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

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );

    abortController.abort();
    await promise;

    const headers: ExchangeHeaders = handler.mock.calls[0][1];
    expect(headers[HeadersKeys.CRON_NAME]).toBe("test-job");
  }, 5000);

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

    await adapter.subscribe(context, handler, abortController);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(abortController.signal.aborted).toBe(true);
    expect(context.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: "cron" }),
      "test error",
    );
  }, 5000);

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

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(2);
      },
      { timeout: 5000 },
    );

    abortController.abort();
    await promise;

    const firstHeaders: ExchangeHeaders = handler.mock.calls[0][1];
    const secondHeaders: ExchangeHeaders = handler.mock.calls[1][1];
    expect(firstHeaders[HeadersKeys.CRON_COUNTER]).toBe(1);
    expect(secondHeaders[HeadersKeys.CRON_COUNTER]).toBe(2);
  }, 10000);

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

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );

    abortController.abort();
    await promise;

    const headers: ExchangeHeaders = handler.mock.calls[0][1];
    expect(headers[HeadersKeys.CRON_NAME]).toBe("factory-test");
    expect(headers[HeadersKeys.CRON_TIMEZONE]).toBe("UTC");
  }, 5000);

  /**
   * @case jitterMs delays handler execution without leaking timeouts
   * @preconditions CronSourceAdapter with per-second expression, jitterMs=200, maxFires=1
   * @expectedResult Handler is called exactly once after jitter delay
   */
  test("jitterMs delays handler execution correctly", async () => {
    const adapter = new CronSourceAdapter("* * * * * *", {
      maxFires: 1,
      jitterMs: 200,
    });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );

    abortController.abort();
    await promise;

    // Wait extra to verify no additional calls leak after resolve
    await new Promise((r) => setTimeout(r, 1500));
    expect(handler).toHaveBeenCalledTimes(1);
  }, 10000);

  /**
   * @case Aborting during jitter delay does not fire handler
   * @preconditions CronSourceAdapter with per-second expression and jitterMs=5000, aborted before jitter elapses
   * @expectedResult Handler is never called, subscribe resolves cleanly
   */
  test("abort during jitter delay prevents handler call", async () => {
    const adapter = new CronSourceAdapter("* * * * * *", {
      jitterMs: 5000,
    });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    // Wait for the cron to fire (triggers every second), then abort
    // before the 5000ms jitter elapses
    await new Promise((r) => setTimeout(r, 1200));
    abortController.abort();
    await promise;

    // Handler should not have been called since jitter hadn't elapsed
    expect(handler).toHaveBeenCalledTimes(0);
  }, 10000);

  /**
   * @case nextRun header is provided when there is a next run
   * @preconditions CronSourceAdapter with per-second expression and maxFires=1
   * @expectedResult Headers contain a valid nextRun ISO string
   */
  test("nextRun header is populated", async () => {
    const adapter = new CronSourceAdapter("* * * * * *", { maxFires: 1 });
    const context = mockContext();
    const abortController = new AbortController();
    const handler = vi.fn().mockResolvedValue({} as Exchange);

    const promise = adapter.subscribe(context, handler, abortController);

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );

    abortController.abort();
    await promise;

    const headers: ExchangeHeaders = handler.mock.calls[0][1];
    const nextRun = headers[HeadersKeys.CRON_NEXT_RUN];
    expect(nextRun).toBeDefined();
    expect(new Date(nextRun as string).getTime()).toBeGreaterThan(0);
  }, 5000);
});
