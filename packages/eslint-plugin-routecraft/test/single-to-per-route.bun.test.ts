import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import singleToPerRouteRule from "../src/rules/single-to-per-route";

// Bind RuleTester runner hooks before any .run(); rule cases must be
// declared at module top-level under bun:test (it doesn't allow new
// test() registrations from inside a running test() callback).
// See .standards/testing.md § 2 for why RuleTester files use
// describe-level JSDoc instead of per-test JSDoc.
(
  RuleTester as unknown as { describe: typeof describe; it: typeof test }
).describe = describe;
(RuleTester as unknown as { describe: typeof describe; it: typeof test }).it =
  test;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

/**
 * @case single-to-per-route rule: one .to() per route segment passes; multiple .to() calls in the same segment are flagged
 * @preconditions craft() chains with varying .to() counts per route segment
 * @expectedResult Valid cases produce no errors; each invalid case produces exactly one multipleToPerRoute error
 */
ruleTester.run("single-to-per-route", singleToPerRouteRule, {
  valid: [
    {
      code: `
        import { craft, simple, log } from "@routecraft/routecraft";
        craft()
          .from(simple(['a', 'b']))
          .to(log());
      `,
    },
    {
      code: `
        craft()
          .from(simple(1))
          .tap(log())
          .to(dest);
      `,
    },
    {
      code: `
        craft()
          .from(simple(1))
          .enrich(http({ url: 'https://api.example.com' }))
          .to(dest);
      `,
    },
    {
      code: `
        craft()
          .from(simple(1))
          .to(log())
          .from(simple(2))
          .to(log());
      `,
    },
    {
      code: `
        api().from(x).to(a).to(b);
      `,
    },
  ],
  invalid: [
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
