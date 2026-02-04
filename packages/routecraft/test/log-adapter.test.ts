import { describe, test, expect, vi } from "vitest";
import { LogAdapter, log, debug } from "../src/index.ts";
import type { Exchange } from "../src/exchange.ts";

function mockExchange<T = unknown>(
  body: T,
): Exchange<T> & {
  logger: {
    trace: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    fatal: ReturnType<typeof vi.fn>;
  };
} {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  return {
    id: "test-id",
    body,
    headers: {},
    logger,
  } as Exchange<T> & { logger: typeof logger };
}

describe("LogAdapter", () => {
  /**
   * @case Default level is info for send()
   * @preconditions LogAdapter created with no options
   * @expectedResult exchange.logger.info() is called
   */
  test("send() uses info level by default", async () => {
    const adapter = new LogAdapter();
    const exchange = mockExchange("hello");

    await adapter.send(exchange);

    expect(exchange.logger.info).toHaveBeenCalledTimes(1);
    expect(exchange.logger.info).toHaveBeenCalledWith(
      { id: "test-id", body: "hello", headers: {} },
      "LogAdapter output",
    );
    expect(exchange.logger.debug).not.toHaveBeenCalled();
  });

  /**
   * @case Default level is info for tap()
   * @preconditions LogAdapter created with no options
   * @expectedResult exchange.logger.info() is called
   */
  test("tap() uses info level by default", async () => {
    const adapter = new LogAdapter();
    const exchange = mockExchange("hello");

    await adapter.tap(exchange);

    expect(exchange.logger.info).toHaveBeenCalledTimes(1);
    expect(exchange.logger.info).toHaveBeenCalledWith(
      { id: "test-id", body: "hello", headers: {} },
      "LogAdapter tap",
    );
  });

  /**
   * @case Options level overrides default
   * @preconditions LogAdapter created with undefined formatter and { level: 'debug' }
   * @expectedResult exchange.logger.debug() is called
   */
  test("send() and tap() use configured level", async () => {
    const adapter = new LogAdapter(undefined, { level: "debug" });
    const exchange = mockExchange("data");

    await adapter.send(exchange);
    expect(exchange.logger.debug).toHaveBeenCalledWith(
      { id: "test-id", body: "data", headers: {} },
      "LogAdapter output",
    );

    exchange.logger.debug.mockClear();
    await adapter.tap(exchange);
    expect(exchange.logger.debug).toHaveBeenCalledWith(
      { id: "test-id", body: "data", headers: {} },
      "LogAdapter tap",
    );
  });

  /**
   * @case Formatter function as first parameter
   * @preconditions LogAdapter created with formatter function only
   * @expectedResult level is info, formatter output is logged
   */
  test("constructor accepts formatter function as first param", async () => {
    const adapter = new LogAdapter((ex) => `body: ${ex.body}`);
    const exchange = mockExchange("payload");

    await adapter.send(exchange);

    expect(exchange.logger.info).toHaveBeenCalledWith(
      "body: payload",
      "LogAdapter output",
    );
  });

  /**
   * @case Formatter and level in separate parameters
   * @preconditions LogAdapter created with formatter as first param and { level: 'warn' } as second
   * @expectedResult exchange.logger.warn() called with formatter result
   */
  test("constructor with formatter and level option", async () => {
    const adapter = new LogAdapter((ex) => ({ custom: ex.body }), {
      level: "warn",
    });
    const exchange = mockExchange({ foo: 1 });

    await adapter.send(exchange);

    expect(exchange.logger.warn).toHaveBeenCalledWith(
      { custom: { foo: 1 } },
      "LogAdapter output",
    );
  });
});

describe("log() DSL", () => {
  /**
   * @case log() with no args creates adapter with default level
   * @preconditions log() called with no arguments
   * @expectedResult Adapter uses info level
   */
  test("log() with no args uses info level", async () => {
    const adapter = log();
    const exchange = mockExchange("x");

    await adapter.send(exchange);

    expect(exchange.logger.info).toHaveBeenCalledTimes(1);
  });

  /**
   * @case log(formatter) uses formatter and info level
   * @preconditions log((ex) => ...) called
   * @expectedResult Adapter uses formatter and info level
   */
  test("log(formatter) uses formatter and info level", async () => {
    const adapter = log((ex) => ex.id);
    const exchange = mockExchange("y");

    await adapter.send(exchange);

    expect(exchange.logger.info).toHaveBeenCalledWith(
      "test-id",
      "LogAdapter output",
    );
  });

  /**
   * @case log(undefined, { level }) uses specified level
   * @preconditions log(undefined, { level: 'debug' }) called
   * @expectedResult Adapter uses debug level
   */
  test("log(undefined, { level: 'debug' }) uses debug level", async () => {
    const adapter = log(undefined, { level: "debug" });
    const exchange = mockExchange("z");

    await adapter.send(exchange);

    expect(exchange.logger.debug).toHaveBeenCalledTimes(1);
  });

  /**
   * @case log(formatter, { level }) uses both
   * @preconditions log(formatter, { level: 'error' }) called
   * @expectedResult Adapter uses error level and formatter
   */
  test("log(formatter, { level: 'error' }) uses both", async () => {
    const adapter = log((ex) => ex.body, { level: "error" });
    const exchange = mockExchange("err-payload");

    await adapter.send(exchange);

    expect(exchange.logger.error).toHaveBeenCalledWith(
      "err-payload",
      "LogAdapter output",
    );
  });
});

describe("debug() DSL helper", () => {
  /**
   * @case debug() creates adapter at debug level
   * @preconditions debug() called with no args
   * @expectedResult Adapter uses debug level
   */
  test("debug() uses debug level", async () => {
    const adapter = debug();
    const exchange = mockExchange("debug-data");

    await adapter.send(exchange);

    expect(exchange.logger.debug).toHaveBeenCalledTimes(1);
    expect(exchange.logger.debug).toHaveBeenCalledWith(
      { id: "test-id", body: "debug-data", headers: {} },
      "LogAdapter output",
    );
  });

  /**
   * @case debug(formatter) uses debug level with formatter
   * @preconditions debug((ex) => ...) called
   * @expectedResult Adapter uses debug level and formatter
   */
  test("debug(formatter) uses debug level with formatter", async () => {
    const adapter = debug((ex) => ({ debugBody: ex.body }));
    const exchange = mockExchange("test");

    await adapter.send(exchange);

    expect(exchange.logger.debug).toHaveBeenCalledWith(
      { debugBody: "test" },
      "LogAdapter output",
    );
  });

  /**
   * @case debug() works with tap()
   * @preconditions debug() used in tap()
   * @expectedResult exchange.logger.debug() called with tap message
   */
  test("debug() works with tap()", async () => {
    const adapter = debug((ex) => `Debugging: ${ex.body}`);
    const exchange = mockExchange("tap-test");

    await adapter.tap(exchange);

    expect(exchange.logger.debug).toHaveBeenCalledWith(
      "Debugging: tap-test",
      "LogAdapter tap",
    );
  });
});
