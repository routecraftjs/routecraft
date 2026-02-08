import { describe, test } from "vitest";
import { RuleTester } from "eslint";
import toolSourceOptionsRule from "../src/rules/tool-source-options";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("tool-source-options", () => {
  /**
   * @case Verifies that tool() with options in .from() passes
   * @preconditions Routes that use .from(tool('name', { description: '...' }))
   * @expectedResult No errors should be reported
   */
  test("valid cases pass", () => {
    ruleTester.run("tool-source-options", toolSourceOptionsRule, {
      valid: [
        // tool() with options in .from()
        {
          code: `
            craft()
              .id("my-tool")
              .from(tool("my-tool", { description: "My tool" }))
              .to(log());
          `,
        },
        // tool() with options including schema
        {
          code: `
            craft()
              .id("my-tool")
              .from(tool("my-tool", { description: "My tool", schema: z.object({}) }))
              .to(consumer);
          `,
        },
        // tool() without options in .to() is fine
        {
          code: `
            craft()
              .id("producer")
              .from(simple({ message: "hello" }))
              .to(tool("my-tool"));
          `,
        },
        // direct() in .from() is not affected
        {
          code: `
            craft()
              .id("my-route")
              .from(direct("endpoint", {}))
              .to(log());
          `,
        },
        // Other adapters in .from() are not affected
        {
          code: `
            craft()
              .id("my-route")
              .from(simple({ data: "test" }))
              .to(log());
          `,
        },
        // tool() not in .from() context
        {
          code: `
            const adapter = tool("my-tool");
          `,
        },
      ],
      invalid: [],
    });
  });

  /**
   * @case Verifies that tool() without options in .from() is caught
   * @preconditions Routes that use .from(tool('name')) without options
   * @expectedResult Errors should be reported
   */
  test("tool() without options in .from() is caught", () => {
    ruleTester.run("tool-source-options", toolSourceOptionsRule, {
      valid: [],
      invalid: [
        {
          code: `
            craft()
              .id("my-tool")
              .from(tool("my-tool"))
              .to(log());
          `,
          errors: [
            {
              messageId: "missingOptions",
            },
          ],
        },
        {
          code: `
            craft()
              .id("consumer")
              .from(tool("endpoint"))
              .process((body) => body);
          `,
          errors: [
            {
              messageId: "missingOptions",
            },
          ],
        },
      ],
    });
  });

  /**
   * @case Verifies that multiple routes are independently validated
   * @preconditions Multiple routes with mixed valid/invalid tool() usage
   * @expectedResult Only invalid routes should be reported
   */
  test("multiple routes are independently validated", () => {
    ruleTester.run("tool-source-options", toolSourceOptionsRule, {
      valid: [],
      invalid: [
        {
          code: `
            const route1 = craft()
              .id("valid")
              .from(tool("t1", { description: "Valid" }))
              .to(log());
            const route2 = craft()
              .id("invalid")
              .from(tool("t2"))
              .to(log());
            const route3 = craft()
              .id("also-valid")
              .from(simple("data"))
              .to(tool("t1"));
          `,
          errors: [
            {
              messageId: "missingOptions",
            },
          ],
        },
      ],
    });
  });
});
