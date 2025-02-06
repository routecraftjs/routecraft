import { parse } from "comment-parser";

const REQUIRED_TAGS = [
  "testCase",
  "description",
  "preconditions",
  "expectedResult",
];

// Add this at the module level (top of the file)
const globalTestCaseIds = new Set();

/**
 * ESLint rule to enforce JSDoc for all tests and ensure @testCase uniqueness.
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require JSDoc for all tests with @testCase and enforce uniqueness.",
      recommended: true,
    },
    schema: [],
    messages: {
      missingJSDoc: "Test '{{ testName }}' is missing JSDoc documentation.",
      missingTestCase:
        "JSDoc for test '{{ testName }}' must include @testCase.",
      duplicateTestCase:
        "Duplicate @testCase ID '{{ testCaseId }}' found in {{ fileName }}.",
      missingRequiredTags:
        "JSDoc for test '{{ testName }}' is missing required tags: {{ missingTags }}.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          (node.callee.name === "test" || node.callee.name === "it")
        ) {
          const testName = node.arguments[0]?.value || "Unnamed test";
          const sourceCode = context.getSourceCode();
          const testLine = node.loc.start.line;

          // Get all comments and find the closest JSDoc
          const jsDocComment = sourceCode
            .getAllComments()
            .filter((comment) => {
              return (
                comment.type === "Block" &&
                comment.value.startsWith("*") &&
                comment.loc.end.line <= testLine &&
                testLine - comment.loc.end.line <= 2
              );
            })
            .sort((a, b) => b.loc.start.line - a.loc.start.line)[0];

          if (!jsDocComment) {
            context.report({
              node,
              messageId: "missingJSDoc",
              data: { testName },
            });
            return;
          }

          // Clean and parse the JSDoc
          const cleaned = jsDocComment.value
            .split("\n")
            .map((line) => line.replace(/^\s*\* ?/, ""))
            .join("\n");

          const [docBlock] = parse(`/**\n${cleaned}\n*/`, {
            spacing: "compact",
          });

          if (!docBlock) {
            context.report({
              node,
              messageId: "missingJSDoc",
              data: { testName },
            });
            return;
          }

          // Extract tags
          const docTags = Object.fromEntries(
            docBlock.tags.map((tag) => [tag.tag, tag.name || tag.description]),
          );

          // Validate required tags
          const missingTags = REQUIRED_TAGS.filter((tag) => !docTags[tag]);
          if (missingTags.length > 0) {
            context.report({
              node,
              messageId: "missingRequiredTags",
              data: { testName, missingTags: missingTags.join(", ") },
            });
            return;
          }

          // Check @testCase
          if (!docTags.testCase) {
            context.report({
              node,
              messageId: "missingTestCase",
              data: { testName },
            });
            return;
          }

          // Check uniqueness
          const testCaseId = docTags.testCase;
          if (globalTestCaseIds.has(testCaseId)) {
            context.report({
              node,
              messageId: "duplicateTestCase",
              data: { testCaseId, fileName: context.getFilename() },
            });
          } else {
            globalTestCaseIds.add(testCaseId);
          }
        }
      },
    };
  },
};
