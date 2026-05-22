import { vi } from "vitest";

/**
 * Spy logger with vi.fn() methods for assertions (e.g. expect(t.logger.info).toHaveBeenCalledWith(...)).
 *
 * @beta
 */
export type SpyLogger = {
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof vi.fn>;
  fatal: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
};

/** @beta */
export function createSpyLogger(): SpyLogger {
  const spy: SpyLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  spy.child.mockImplementation(() => spy);
  return spy;
}

/** @beta */
export function createNoopSpyLogger(): SpyLogger {
  const noop = vi.fn();
  const childFn = vi.fn();
  const noopLogger: SpyLogger = {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    trace: noop,
    fatal: noop,
    child: childFn,
  };
  childFn.mockImplementation(() => noopLogger);
  return noopLogger;
}
