import { describe, test } from "vitest";
import { RuleTester } from "eslint";
import singleToPerRouteRule from "../src/rules/single-to-per-route";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("single-to-per-route", () => {
  /**
   * @case Verifies that valid cases pass (single .to() per route, .tap() with .to(), etc.)
   * @preconditions Routes with one .to() per route, or non-craft chains
   * @expectedResult No errors should be reported
   */
  test("valid cases pass", () => {
    ruleTester.run("single-to-per-route", singleToPerRouteRule, {
      valid: [
        // single .to() per route
        {
          code: `
            import { craft, simple, log } from "@routecraft/routecraft";
            craft()
              .from(simple(['a', 'b']))
              .to(log());
          `,
        },
        // .tap() and .to() - only one .to()
        {
          code: `
            craft()
              .from(simple(1))
              .tap(log())
              .to(dest);
          `,
        },
        // .enrich() and .to()
        {
          code: `
            craft()
              .from(simple(1))
              .enrich(fetch({ url: 'https://api.example.com' }))
              .to(dest);
          `,
        },
        // multiple routes, one .to() each
        {
          code: `
            craft()
              .from(simple(1))
              .to(log())
              .from(simple(2))
              .to(log());
          `,
        },
        // non-craft chains are ignored
        {
          code: `
            api().from(x).to(a).to(b);
          `,
        },
      ],
      invalid: [],
    });
  });

  /**
   * @case Verifies that invalid cases are reported (multiple .to() in one route)
   * @preconditions Routes that call .to() multiple times after the same .from()
   * @expectedResult Errors should be reported for routes with multiple .to() operations
   */
  test("invalid cases are reported", () => {
    ruleTester.run("single-to-per-route", singleToPerRouteRule, {
      valid: [],
      invalid: [
        // two .to() in one route
        {
          code: `
            import { craft, simple, log } from "@routecraft/routecraft";
            craft()
              .from(simple([1,2,3]))
              .to(log())
              .to(dest);
          `,
          errors: [{ messageId: "multipleToPerRoute" }],
        },
        // three .to() in one route - report on 2nd and 3rd (rule reports on the last .to() when it's not the first)
        {
          code: `
            craft()
              .from(simple(1))
              .to(a)
              .to(b)
              .to(c);
          `,
          errors: [{ messageId: "multipleToPerRoute" }],
        },
        // second route has two .to()
        {
          code: `
            craft()
              .from(simple(1))
              .to(log())
              .from(simple(2))
              .to(a)
              .to(b);
          `,
          errors: [{ messageId: "multipleToPerRoute" }],
        },
      ],
    });
  });
});
