import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import batchBeforeFromRule from "../src/rules/batch-before-from";

// ESLint's RuleTester registers describe/it blocks dynamically when
// `.run(...)` is called. Bun:test does not allow new test registrations
// from inside a running test() callback, so `.run(...)` must happen at
// module top-level. Bind RuleTester's runner hooks to bun:test before
// any registration. See .standards/testing.md § 2 for why RuleTester
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
 * @case batch-before-from rule: valid placements pass, post-from placements are flagged
 * @preconditions craft() chains with batch() at various positions relative to from()
 * @expectedResult Valid cases produce no errors; invalid cases produce exactly one batchAfterFrom error each
 */
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
