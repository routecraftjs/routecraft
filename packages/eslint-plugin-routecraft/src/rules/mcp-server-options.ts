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

function isObjectExpression(
  node: unknown,
): node is { type: "ObjectExpression"; properties: unknown[] } {
  return (
    isObject(node) &&
    node["type"] === "ObjectExpression" &&
    Array.isArray(node["properties"])
  );
}

function isLiteral(
  node: unknown,
): node is { type: "Literal"; value: string | number | boolean | null } {
  return isObject(node) && node["type"] === "Literal" && "value" in node;
}

function isProperty(node: unknown): node is {
  type: "Property";
  key: unknown;
  value: unknown;
} {
  return (
    isObject(node) &&
    node["type"] === "Property" &&
    "key" in node &&
    "value" in node
  );
}

function getPropertyKeyName(key: unknown): string | undefined {
  if (isIdentifier(key)) return key.name;
  if (isLiteral(key) && typeof key.value === "string") return key.value;
  return undefined;
}

/** Returns true if the object has a description property that is a non-empty string literal. */
function hasDescriptionOption(obj: {
  type: "ObjectExpression";
  properties: unknown[];
}): boolean {
  for (const prop of obj.properties) {
    if (!isProperty(prop)) continue;
    const name = getPropertyKeyName(prop.key);
    if (name !== "description") continue;
    if (!isLiteral(prop.value)) return false;
    return typeof prop.value.value === "string" && prop.value.value.length > 0;
  }
  return false;
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
        "When using mcp() as a server in .from(), options with description must be provided for discoverability.",
      recommended: false,
    },
    messages: {
      missingOptions:
        "mcp-server-options: mcp() used in .from() must have options with description for AI/MCP discoverability. Use mcp('name', { description: '...' }).",
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

        // Check if the argument is an mcp() call
        if (!isCallExpression(fromArg)) return;

        const fromArgCallee = (fromArg as Record<string, unknown>)[
          "callee"
        ] as unknown;

        // Check if it's a direct mcp() call
        if (!isIdentifier(fromArgCallee) || fromArgCallee.name !== "mcp")
          return;

        // mcp() is called inside .from() - check if it has options (second argument) with description
        const mcpArgs = (fromArg as Record<string, unknown>)["arguments"] as
          | unknown[]
          | undefined;

        if (!Array.isArray(mcpArgs) || mcpArgs.length < 2) {
          context.report({
            node: fromArg as Rule.Node,
            messageId: "missingOptions",
          });
          return;
        }

        const optionsArg = mcpArgs[1];
        if (!isObjectExpression(optionsArg)) {
          context.report({
            node: fromArg as Rule.Node,
            messageId: "missingOptions",
          });
          return;
        }

        if (!hasDescriptionOption(optionsArg)) {
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
