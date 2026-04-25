import { readFileSync } from "node:fs";
import { test } from "vitest";

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
  createSpyLogger,
  createNoopSpyLogger,
  type SpyLogger,
} from "./spy-logger";

// Re-export pseudo adapter
export {
  pseudo,
  type PseudoAdapter,
  type PseudoFactory,
  type PseudoKeyedFactory,
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
 * @beta
 * @param path Absolute or relative path to the JSON file
 * @returns Parsed JSON as T
 */
export function fixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/** Fixture entry must have a `name` field used as the vitest test name. */
export interface FixtureWithName {
  name: string;
  [key: string]: unknown;
}

/**
 * Load a JSON array fixture and run one vitest test per entry. Each entry must have a `name` field (used as the test name).
 *
 * @beta
 * @param path Path to a JSON file that parses to an array
 * @param run Callback invoked per entry; use for assertions. Receives the fixture entry.
 */
export function fixtureEach<T extends FixtureWithName>(
  path: string,
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
