import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * A Standard Schema whose `validate()` returns a plain thenable rather than
 * a real `Promise`.
 *
 * Standard Schema permits this: `validate()` may return a result or a
 * promise of one, and "promise" is the thenable contract, not the `Promise`
 * class. Code that gates on `instanceof Promise` misses such a schema and
 * then treats the thenable object itself as the result record, where the
 * absence of `issues` reads as success. Use this fixture to hold any
 * validation boundary to the contract instead of the class.
 *
 * @param outcome - What the thenable resolves to: `{ value }` to accept,
 *   `{ issues }` to reject
 * @returns A Standard Schema that validates through a non-`Promise` thenable
 *
 * @example
 * ```typescript
 * const rejecting = thenableSchema({ issues: [{ message: "expected number" }] });
 * const accepting = thenableSchema({ value: 42 });
 * ```
 */
export function thenableSchema<T>(
  outcome: StandardSchemaV1.Result<T>,
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "routecraft-testing",
      validate: () =>
        ({
          then: (resolve: (result: StandardSchemaV1.Result<T>) => unknown) =>
            resolve(outcome),
        }) as unknown as StandardSchemaV1.Result<T>,
    },
  };
}
