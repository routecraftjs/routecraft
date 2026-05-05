import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import requireNamedRouteRule from "../src/rules/require-named-route";

// ESLint's RuleTester registers describe/it blocks dynamically when
// `.run(...)` is called. Bun:test does not allow new test registrations
// from inside a running test() callback, so `.run(...)` must happen at
// module top-level. See .standards/testing.md § 2 for why RuleTester
// files use describe-level JSDoc instead of per-test JSDoc.
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
 * @case require-named-route rule: routes with a static string .id() pass; routes without or with a dynamic id are flagged
 * @preconditions craft() chains with various id() usages (missing, empty, whitespace, dynamic expression, late placement)
 * @expectedResult Valid cases produce no errors; each invalid case produces exactly one missingId error
 */
ruleTester.run("require-named-route", requireNamedRouteRule, {
  valid: [
    {
      code: `
        import { craft, simple, log } from "@routecraft/routecraft";
        export default craft()
          .id("user-processor")
          .from(simple({ userId: 1 }))
          .to(log());
      `,
    },
    {
      code: `
        craft()
          .id("complex-route")
          .from(timer({ intervalMs: 5000 }))
          .transform((x) => x * 2)
          .to(log());
      `,
    },
    {
      code: `
        craft().id('quoted-name').from(direct()).to(noop());
      `,
    },
    {
      code: `
        someOtherBuilder().from(source()).to(dest());
      `,
    },
    {
      code: `
        const data = api.from('https://example.com');
      `,
    },
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
          .from(simple({ userId: 1 }))
          .to(log());
      `,
      errors: [{ messageId: "missingId" }],
    },
    {
      code: `
        export default craft().from(timer()).to(noop());
      `,
      errors: [{ messageId: "missingId" }],
    },
    {
      code: `
        craft()
          .id("")
          .from(simple())
          .to(log());
      `,
      errors: [{ messageId: "missingId" }],
    },
    {
      code: `
        craft()
          .id("   ")
          .from(timer())
          .to(log());
      `,
      errors: [{ messageId: "missingId" }],
    },
    {
      code: `
        craft()
          .from(simple())
          .id("late-id")
          .to(log());
      `,
      errors: [{ messageId: "missingId" }],
    },
    {
      code: `
        const route1 = craft().id("valid").from(simple()).to(log());
        const route2 = craft().from(timer()).to(noop());
        const route3 = craft().id("also-valid").from(direct()).to(log());
      `,
      errors: [{ messageId: "missingId" }],
    },
    {
      code: `
        const routeName = "dynamic-name";
        craft()
          .id(routeName)
          .from(simple())
          .to(log());
      `,
      errors: [{ messageId: "missingId" }],
    },
    {
      code: `
        craft()
          .id(getName())
          .from(timer())
          .to(log());
      `,
      errors: [{ messageId: "missingId" }],
    },
    {
      code: `
        craft()
          .metadata({ version: "1.0" })
          .from(simple())
          .transform(x => x)
          .to(log());
      `,
      errors: [{ messageId: "missingId" }],
    },
  ],
});
