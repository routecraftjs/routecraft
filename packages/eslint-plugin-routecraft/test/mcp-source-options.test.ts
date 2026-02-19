import { describe, test } from "vitest";
import { RuleTester } from "eslint";
import mcpSourceOptionsRule from "../src/rules/mcp-source-options";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("mcp-source-options", () => {
  /**
   * @case Verifies that mcp() with options in .from() passes
   * @preconditions Routes that use .from(mcp('name', { description: '...' }))
   * @expectedResult No errors should be reported
   */
  test("valid cases pass", () => {
    ruleTester.run("mcp-source-options", mcpSourceOptionsRule, {
      valid: [
        // mcp() with options in .from()
        {
          code: `
            craft()
              .id("my-tool")
              .from(mcp("my-tool", { description: "My tool" }))
              .to(log());
          `,
        },
        // mcp() with options including schema
        {
          code: `
            craft()
              .id("my-tool")
              .from(mcp("my-tool", { description: "My tool", schema: z.object({}) }))
              .to(consumer);
          `,
        },
        // mcp() without options in .to() is fine
        {
          code: `
            craft()
              .id("producer")
              .from(simple({ message: "hello" }))
              .to(mcp("my-tool"));
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
        // mcp() not in .from() context
        {
          code: `
            const adapter = mcp("my-tool");
          `,
        },
      ],
      invalid: [],
    });
  });

  /**
   * @case Verifies that mcp() without options in .from() is caught
   * @preconditions Routes that use .from(mcp('name')) without options
   * @expectedResult Errors should be reported
   */
  test("mcp() without options in .from() is caught", () => {
    ruleTester.run("mcp-source-options", mcpSourceOptionsRule, {
      valid: [],
      invalid: [
        {
          code: `
            craft()
              .id("my-tool")
              .from(mcp("my-tool"))
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
              .from(mcp("endpoint"))
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
   * @preconditions Multiple routes with mixed valid/invalid mcp() usage
   * @expectedResult Only invalid routes should be reported
   */
  test("multiple routes are independently validated", () => {
    ruleTester.run("mcp-source-options", mcpSourceOptionsRule, {
      valid: [],
      invalid: [
        {
          code: `
            const route1 = craft()
              .id("valid")
              .from(mcp("t1", { description: "Valid" }))
              .to(log());
            const route2 = craft()
              .id("invalid")
              .from(mcp("t2"))
              .to(log());
            const route3 = craft()
              .id("also-valid")
              .from(simple("data"))
              .to(mcp("t1"));
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
