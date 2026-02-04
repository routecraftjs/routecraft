import type { Rule } from "eslint";

// Type guards for minimal ESTree-like nodes we need
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIdentifier(
  node: unknown,
): node is { type: "Identifier"; name: string } {
  return (
    isObject(node) &&
    node["type"] === "Identifier" &&
    typeof node["name"] === "string"
  );
}

function isMemberExpression(node: unknown): node is {
  type: "MemberExpression";
  computed: boolean;
  object: unknown;
  property: unknown;
} {
  return (
    isObject(node) &&
    node["type"] === "MemberExpression" &&
    typeof node["computed"] === "boolean" &&
    "object" in node &&
    "property" in node
  );
}

function isCallExpression(
  node: unknown,
): node is { type: "CallExpression"; callee: unknown; arguments: unknown[] } {
  return (
    isObject(node) &&
    node["type"] === "CallExpression" &&
    Array.isArray(node["arguments"]) &&
    "callee" in node
  );
}

// Utility: find the callee name for a CallExpression like obj.method() or fn()
function getCallName(node: unknown): string | undefined {
  if (!isCallExpression(node)) return undefined;
  const callee = (node as Record<string, unknown>)["callee"] as unknown;
  if (isMemberExpression(callee) && !callee.computed) {
    if (isIdentifier(callee["property"])) {
      return (callee["property"] as { name: string }).name;
    }
  } else if (isIdentifier(callee)) {
    return callee.name;
  }
  return undefined;
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "When using tool() as a source in .from(), options with description must be provided for discoverability.",
      recommended: false,
    },
    messages: {
      missingOptions:
        "tool-source-options: tool() used in .from() must have options with description for AI/MCP discoverability. Use tool('name', { description: '...' }).",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        // Check if this is a .from(...) call
        const callName = getCallName(node);
        if (callName !== "from") return;

        // Get the argument to .from()
        const args = (node as unknown as Record<string, unknown>)[
          "arguments"
        ] as unknown[] | undefined;
        if (!Array.isArray(args) || args.length === 0) return;

        const fromArg = args[0];

        // Check if the argument is a tool() call
        if (!isCallExpression(fromArg)) return;

        const fromArgCallee = (fromArg as Record<string, unknown>)[
          "callee"
        ] as unknown;

        // Check if it's a direct tool() call
        if (!isIdentifier(fromArgCallee) || fromArgCallee.name !== "tool")
          return;

        // tool() is called inside .from() - check if it has options (second argument)
        const toolArgs = (fromArg as Record<string, unknown>)["arguments"] as
          | unknown[]
          | undefined;

        if (!Array.isArray(toolArgs) || toolArgs.length < 2) {
          // tool() called with no options or only endpoint
          context.report({
            node: fromArg as Rule.Node,
            messageId: "missingOptions",
          });
        }
      },
    };
  },
};

export default rule;
