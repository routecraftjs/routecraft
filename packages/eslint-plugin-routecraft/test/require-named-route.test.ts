import { describe, test } from "vitest";
import { RuleTester } from "eslint";
import requireNamedRouteRule from "../src/rules/require-named-route";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("require-named-route", () => {
  /**
   * @case Verifies that the rule correctly validates routes with proper .id() calls
   * @preconditions Routes that call .id() with non-empty strings before .from()
   * @expectedResult No errors should be reported
   */
  test("valid cases pass", () => {
    ruleTester.run("require-named-route", requireNamedRouteRule, {
      valid: [
        // Basic valid case
        {
          code: `
            import { craft, simple, log } from "@routecraftjs/routecraft";
            export default craft()
              .id("user-processor")
              .from(simple({ userId: 1 }))
              .to(log());
          `,
        },
        // Valid with additional operations
        {
          code: `
            craft()
              .id("complex-route")
              .from(timer({ intervalMs: 5000 }))
              .transform((x) => x * 2)
              .to(log());
          `,
        },
        // Valid with string literal
        {
          code: `
            craft().id('quoted-name').from(direct()).to(noop());
          `,
        },
        // Not a craft chain - should be ignored
        {
          code: `
            someOtherBuilder().from(source()).to(dest());
          `,
        },
        // from() not in a craft chain - should be ignored
        {
          code: `
            const data = api.from('https://example.com');
          `,
        },
      ],
      invalid: [],
    });
  });

  /**
   * @case Verifies that the rule catches missing .id() calls
   * @preconditions Routes that call .from() without prior .id()
   * @expectedResult Errors should be reported for each violation
   */
  test("missing .id() is caught", () => {
    ruleTester.run("require-named-route", requireNamedRouteRule, {
      valid: [],
      invalid: [
        {
          code: `
            craft()
              .from(simple({ userId: 1 }))
              .to(log());
          `,
          errors: [
            {
              messageId: "missingId",
            },
          ],
        },
        {
          code: `
            export default craft().from(timer()).to(noop());
          `,
          errors: [
            {
              messageId: "missingId",
            },
          ],
        },
      ],
    });
  });

  /**
   * @case Verifies that the rule catches empty string .id() calls
   * @preconditions Routes that call .id() with empty or whitespace-only strings
   * @expectedResult Errors should be reported for each violation
   */
  test("empty .id() is caught", () => {
    ruleTester.run("require-named-route", requireNamedRouteRule, {
      valid: [],
      invalid: [
        {
          code: `
            craft()
              .id("")
              .from(simple())
              .to(log());
          `,
          errors: [
            {
              messageId: "missingId",
            },
          ],
        },
        {
          code: `
            craft()
              .id("   ")
              .from(timer())
              .to(log());
          `,
          errors: [
            {
              messageId: "missingId",
            },
          ],
        },
      ],
    });
  });

  /**
   * @case Verifies that .id() must appear before .from() in the chain
   * @preconditions Routes that call .id() after .from()
   * @expectedResult Errors should be reported as .id() must come first
   */
  test(".id() after .from() is invalid", () => {
    ruleTester.run("require-named-route", requireNamedRouteRule, {
      valid: [],
      invalid: [
        {
          code: `
            craft()
              .from(simple())
              .id("late-id")
              .to(log());
          `,
          errors: [
            {
              messageId: "missingId",
            },
          ],
        },
      ],
    });
  });

  /**
   * @case Verifies that multiple routes in one file are independently validated
   * @preconditions Multiple route definitions with mixed valid/invalid patterns
   * @expectedResult Only invalid routes should be reported
   */
  test("multiple routes are independently validated", () => {
    ruleTester.run("require-named-route", requireNamedRouteRule, {
      valid: [],
      invalid: [
        {
          code: `
            const route1 = craft().id("valid").from(simple()).to(log());
            const route2 = craft().from(timer()).to(noop());
            const route3 = craft().id("also-valid").from(direct()).to(log());
          `,
          errors: [
            {
              messageId: "missingId",
            },
          ],
        },
      ],
    });
  });

  /**
   * @case Verifies that non-literal .id() values are treated as invalid
   * @preconditions Routes that call .id() with variables or expressions
   * @expectedResult Errors should be reported as we require string literals
   */
  test("non-literal .id() values are invalid", () => {
    ruleTester.run("require-named-route", requireNamedRouteRule, {
      valid: [],
      invalid: [
        {
          code: `
            const routeName = "dynamic-name";
            craft()
              .id(routeName)
              .from(simple())
              .to(log());
          `,
          errors: [
            {
              messageId: "missingId",
            },
          ],
        },
        {
          code: `
            craft()
              .id(getName())
              .from(timer())
              .to(log());
          `,
          errors: [
            {
              messageId: "missingId",
            },
          ],
        },
      ],
    });
  });

  /**
   * @case Verifies that complex chain patterns are correctly parsed
   * @preconditions Routes with multiple intermediate operations between craft() and from()
   * @expectedResult Validation should work correctly regardless of chain complexity
   */
  test("complex chains are correctly validated", () => {
    ruleTester.run("require-named-route", requireNamedRouteRule, {
      valid: [
        {
          code: `
            craft()
              .id("complex")
              .metadata({ version: "1.0" })
              .from(simple())
              .transform(x => x)
              .to(log());
          `,
        },
      ],
      invalid: [
        {
          code: `
            craft()
              .metadata({ version: "1.0" })
              .from(simple())
              .transform(x => x)
              .to(log());
          `,
          errors: [
            {
              messageId: "missingId",
            },
          ],
        },
      ],
    });
  });
});
