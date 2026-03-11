import { describe, test } from "vitest";
import { RuleTester } from "eslint";
import errorBeforeFromRule from "../src/rules/error-before-from";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("error-before-from", () => {
  /**
   * @case Verifies that valid cases pass (error before from, no error, etc.)
   * @preconditions Routes with error() before from(), routes without error(), or non-craft chains
   * @expectedResult No errors should be reported
   */
  test("valid cases pass", () => {
    ruleTester.run("error-before-from", errorBeforeFromRule, {
      valid: [
        // error before from
        {
          code: `
            import { craft, simple, log } from "@routecraft/routecraft";
            craft()
              .error((err, ex) => ({ failed: true }))
              .from(simple(['a', 'b']))
              .to(log());
          `,
        },
        // with id and other ops
        {
          code: `
            craft()
              .id('r')
              .error((err, ex) => err)
              .from(simple([1,2,3]))
              .transform(x => x)
              .to(log());
          `,
        },
        // no error usage
        {
          code: `
            craft().id('r').from(simple(1)).to(log());
          `,
        },
        // non-craft chains are ignored
        {
          code: `
            api().from(x).error(handler).to(y);
          `,
        },
      ],
      invalid: [],
    });
  });

  /**
   * @case Verifies that invalid cases are reported (error after from)
   * @preconditions Routes that call error() after from() in the same chain
   * @expectedResult Errors should be reported for each violation
   */
  test("invalid cases are reported", () => {
    ruleTester.run("error-before-from", errorBeforeFromRule, {
      valid: [],
      invalid: [
        // error after from
        {
          code: `
            import { craft, simple } from "@routecraft/routecraft";
            craft()
              .from(simple([1,2,3]))
              .error((err, ex) => ({ failed: true }))
              .to(dest);
          `,
          errors: [{ messageId: "errorAfterFrom" }],
        },
        // id then from then error
        {
          code: `
            craft()
              .id('r')
              .from(simple(1))
              .error(handler);
          `,
          errors: [{ messageId: "errorAfterFrom" }],
        },
        // error at the end of a chain after from and other steps
        {
          code: `
            craft()
              .from(simple(1))
              .transform(x => x)
              .to(dest)
              .error(handler);
          `,
          errors: [{ messageId: "errorAfterFrom" }],
        },
      ],
    });
  });
});
