import { describe, test } from "vitest";
import { RuleTester } from "eslint";
import batchBeforeFromRule from "../src/rules/batch-before-from";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("batch-before-from", () => {
  /**
   * @case Verifies that valid cases pass (batch before from, no batch, etc.)
   * @preconditions Routes with batch() before from(), routes without batch(), or non-craft chains
   * @expectedResult No errors should be reported
   */
  test("valid cases pass", () => {
    ruleTester.run("batch-before-from", batchBeforeFromRule, {
      valid: [
        // batch before from
        {
          code: `
            import { craft, simple, log } from "@routecraft/routecraft";
            craft()
              .batch({ size: 10 })
              .from(simple(['a', 'b']))
              .to(log());
          `,
        },
        // with id and other ops
        {
          code: `
            craft()
              .id('r')
              .batch({ size: 10, flushIntervalMs: 1000 })
              .from(simple([1,2,3]))
              .transform(x => x)
              .to(log());
          `,
        },
        // no batch usage
        {
          code: `
            craft().id('r').from(simple(1)).to(log());
          `,
        },
        // multiple routes staged: batch before each from
        {
          code: `
            craft()
              .batch()
              .from(simple(1))
              .to(log())
              .batch({ size: 5 })
              .from(simple(2))
              .to(log());
          `,
        },
        // Non-craft chains are ignored
        {
          code: `
            api().from(x).batch().to(y);
          `,
        },
      ],
      invalid: [],
    });
  });

  /**
   * @case Verifies that invalid cases are reported (batch after from)
   * @preconditions Routes that call batch() after from() in the same chain
   * @expectedResult Errors should be reported for each violation
   */
  test("invalid cases are reported", () => {
    ruleTester.run("batch-before-from", batchBeforeFromRule, {
      valid: [],
      invalid: [
        // batch after from
        {
          code: `
            import { craft, simple } from "@routecraft/routecraft";
            craft()
              .from(simple([1,2,3]))
              .batch({ size: 10 })
              .to(dest);
          `,
          errors: [{ messageId: "batchAfterFrom" }],
        },
        // appears later in chain without a new from
        {
          code: `
            craft()
              .batch()
              .from(simple([1,2,3]))
              .to(dest)
              .batch({ size: 2 });
          `,
          errors: [{ messageId: "batchAfterFrom" }],
        },
        // id then from then batch
        {
          code: `
            craft()
              .id('r')
              .from(simple(1))
              .batch();
          `,
          errors: [{ messageId: "batchAfterFrom" }],
        },
        // multiple routes, second route has late batch
        {
          code: `
            craft()
              .batch()
              .from(simple(1))
              .to(dest)
              .from(simple(2))
              .batch();
          `,
          errors: [{ messageId: "batchAfterFrom" }],
        },
      ],
    });
  });
});
