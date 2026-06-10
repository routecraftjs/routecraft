import { readFileSync } from "node:fs";

// Re-export test context utilities
export {
  TestContext,
  TestContextBuilder,
  testContext,
  type TestContextOptions,
  type TestOptions,
} from "./test-context";

// Re-export spy logger utilities
export {
  createSpyFn,
  createSpyLogger,
  createNoopSpyLogger,
  type SpyFn,
  type SpyFactory,
  type SpyLogger,
} from "./spy-logger";

// Re-export pseudo adapter
export {
  pseudo,
  type PseudoOptions,
  type PseudoKeyedOptions,
} from "./adapters/pseudo";

// Re-export spy adapter
export { spy, type SpyAdapter } from "./adapters/spy";

// Adapter mocking API
export {
  mockAdapter,
  type AdapterMock,
  type MockAdapterBehavior,
} from "./mock-adapter";

// Source fixture helper: attach headers to a source-role mock fixture so
// routes that read `routecraft.<adapter>.*` headers can be exercised.
export { sourceMessage } from "./source-message";

// Test helper for fn-like specs (schema + handler). Used to exercise
// fns registered in `@routecraft/ai`'s agentPlugin without depending on
// any non-public dispatcher.
export {
  testFn,
  type TestFnHandlerContext,
  type TestFnOptions,
  type TestFnSpec,
} from "./test-fn";

/**
 * Load a JSON fixture file and return the parsed value.
 *
 * @param path Absolute or relative path to the JSON file
 * @returns Parsed JSON as T
 */
export function fixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/**
 * Fixture entry must have a `name` field used as the test name.
 */
export interface FixtureWithName {
  name: string;
  [key: string]: unknown;
}

/**
 * A test runner's `test` function, as accepted by {@link fixtureEach}.
 * Both `test` from bun:test and `test` from Vitest satisfy this shape.
 */
export type FixtureTestFn = (
  name: string,
  fn: () => void | Promise<void>,
) => unknown;

/**
 * Load a JSON array fixture and run one test per entry. Each entry must have
 * a `name` field (used as the test name). Runner-agnostic: pass your runner's
 * `test` function (bun:test, Vitest, node:test).
 *
 * @param path Path to a JSON file that parses to an array
 * @param test The runner's `test` function used to register each entry
 * @param run Callback invoked per entry; use for assertions. Receives the fixture entry.
 *
 * @example
 * import { test } from "bun:test";
 * fixtureEach("./cases.json", test, (entry) => {
 *   expect(run(entry.input)).toEqual(entry.expected);
 * });
 */
export function fixtureEach<T extends FixtureWithName>(
  path: string,
  test: FixtureTestFn,
  run: (entry: T) => void | Promise<void>,
): void {
  const entries = fixture<T[]>(path);
  if (!Array.isArray(entries)) {
    throw new Error(
      `fixture.each: expected JSON array at "${path}", got ${typeof entries}`,
    );
  }
  for (const entry of entries) {
    if (typeof entry?.name !== "string") {
      throw new Error(
        `fixture.each: each entry must have a "name" field (string). Got: ${JSON.stringify(entry)}`,
      );
    }
    test(entry.name, () => run(entry));
  }
}
