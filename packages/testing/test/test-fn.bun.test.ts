import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { testFn } from "../src/test-fn.ts";
import { thenableSchema } from "../src/thenable-schema.ts";

/**
 * `testFn` is where a fn's schema is exercised in isolation, so a schema it
 * fails to enforce is a fn that passes its own test with input the runtime
 * would refuse. That makes the thenable contract load-bearing here (see
 * `validateAgainst` for what it is).
 */
describe("testFn with a schema returning a thenable", () => {
  /**
   * @case testFn refuses input a thenable schema rejected
   * @preconditions spec.input is a schema whose validate() returns a rejecting non-Promise thenable
   * @expectedResult RC5002 is thrown and the handler never runs
   */
  test("throws RC5002 and does not run the handler", async () => {
    let ran = false;
    const spec = {
      input: thenableSchema<number>({
        issues: [{ message: "expected number" }],
      }),
      handler: async () => {
        ran = true;
        return "handled";
      },
    };

    await expect(testFn(spec, "not a number")).rejects.toMatchObject({
      rc: "RC5002",
    });
    expect(ran).toBe(false);
  });

  /**
   * @case testFn hands the handler the value a thenable schema accepted with
   * @preconditions spec.input is a schema whose validate() returns a thenable resolving to a transformed value
   * @expectedResult The handler receives the transformed value, so awaiting the thenable feeds the success path too
   */
  test("passes the thenable's transformed value to the handler", async () => {
    const spec = {
      input: thenableSchema({ value: 42 }),
      handler: async (input: number) => input,
    };

    expect(await testFn(spec, "forty-two")).toBe(42);
  });

  /**
   * @case A real async schema still validates
   * @preconditions spec.input returns an actual Promise resolving to issues
   * @expectedResult RC5002 is thrown, so widening the check to any thenable did not cost the Promise case
   */
  test("still validates a real async schema", async () => {
    const spec = {
      input: {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: async () => ({ issues: [{ message: "async reject" }] }),
        },
      } as unknown as StandardSchemaV1<unknown, number>,
      handler: async (input: number) => input,
    };

    await expect(testFn(spec, 1)).rejects.toMatchObject({ rc: "RC5002" });
  });
});
