import { parse } from "comment-parser";

const REQUIRED_TAGS = ["case", "preconditions", "expectedResult"];

// For now, only track uniqueness within each file to avoid ESLint state issues
// TODO: Add a separate script to check cross-file uniqueness during CI

/**
 * ESLint rule to enforce JSDoc for all tests with @case documentation.
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require JSDoc for all tests with @case, @preconditions, and @expectedResult.",
      recommended: true,
    },
    schema: [],
    messages: {
      missingJSDoc: "Test '{{ testName }}' is missing JSDoc documentation.",
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

          // All validation is now handled by the missing required tags check above
        }
      },
    };
  },
};
