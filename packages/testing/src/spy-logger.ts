/**
 * Minimal runner-agnostic spy function. Records calls in the jest-compatible
 * `mock.calls` shape so assertions like
 * `expect(t.logger.warn.mock.calls.some(...))` work under bun:test, Vitest,
 * and node:test without this package importing any runner.
 *
 * Runner mocks (`vi.fn` from Vitest, `mock` from bun:test) are structurally
 * assignable to this interface, so they can be injected via {@link SpyFactory}
 * when full matcher support (`expect(fn).toHaveBeenCalledWith(...)`) is
 * wanted.
 */
export interface SpyFn {
  (...args: unknown[]): unknown;
  mock: { calls: unknown[][] };
  mockImplementation(impl: (...args: unknown[]) => unknown): SpyFn;
  mockClear(): void;
}

/**
 * Factory producing spy functions. Defaults to the built-in {@link createSpyFn};
 * pass your runner's mock factory (`vi.fn`, or `mock` from bun:test) to get
 * native mocks that work with the runner's `expect` matchers.
 */
export type SpyFactory = () => SpyFn;

/**
 * Create a built-in spy function. Dependency-free; records calls in
 * `fn.mock.calls` and supports `mockImplementation` / `mockClear`.
 */
export function createSpyFn(): SpyFn {
  let impl: ((...args: unknown[]) => unknown) | undefined;
  const calls: unknown[][] = [];
  const fn = ((...args: unknown[]): unknown => {
    calls.push(args);
    return impl?.(...args);
  }) as SpyFn;
  fn.mock = { calls };
  fn.mockImplementation = (next) => {
    impl = next;
    return fn;
  };
  fn.mockClear = () => {
    calls.length = 0;
  };
  return fn;
}

/**
 * Spy logger with spy methods for assertions (e.g.
 * `t.logger.info.mock.calls` under any runner, or
 * `expect(t.logger.info).toHaveBeenCalledWith(...)` when built from an
 * injected runner mock factory).
 */
export type SpyLogger = {
  info: SpyFn;
  debug: SpyFn;
  warn: SpyFn;
  error: SpyFn;
  trace: SpyFn;
  fatal: SpyFn;
  child: SpyFn;
};

export function createSpyLogger(fn: SpyFactory = createSpyFn): SpyLogger {
  const spy: SpyLogger = {
    info: fn(),
    debug: fn(),
    warn: fn(),
    error: fn(),
    trace: fn(),
    fatal: fn(),
    child: fn(),
  };
  spy.child.mockImplementation(() => spy);
  return spy;
}

export function createNoopSpyLogger(fn: SpyFactory = createSpyFn): SpyLogger {
  const noop = fn();
  const childFn = fn();
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
