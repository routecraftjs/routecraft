import type { Rule } from "eslint";

// Type Guards

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

function getMemberCallName(node: unknown): string | undefined {
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

function originatesFromCraft(call: unknown): boolean {
  let current: unknown = call;

  while (isCallExpression(current)) {
    const callee = (current as Record<string, unknown>)["callee"] as unknown;

    if (isIdentifier(callee) && callee.name === "craft") {
      return true;
    }

    if (isMemberExpression(callee)) {
      current = callee["object"] as unknown;
      continue;
    }

    break;
  }

  return false;
}

function collectChainBackwards(node: unknown): unknown[] {
  const callsInReverse: unknown[] = [];
  let current: unknown = node;

  while (isCallExpression(current)) {
    callsInReverse.push(current);
    const callee = (current as Record<string, unknown>)["callee"] as unknown;

    if (isMemberExpression(callee)) {
      current = callee["object"] as unknown;
    } else {
      break;
    }
  }

  return callsInReverse.reverse();
}

function findLastFromIndex(chain: unknown[], beforeIndex: number): number {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const call = chain[i];
    if (isCallExpression(call) && getMemberCallName(call) === "from") {
      return i;
    }
  }
  return -1;
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ensure error() is used as a route-level operation (before from()).",
      recommended: false,
    },
    messages: {
      errorAfterFrom:
        "error-before-from: .error() must be configured before .from(); it is a route-level operation and has no effect after the source is defined.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (getMemberCallName(node) !== "error") return;
        if (!originatesFromCraft(node)) return;

        const chain = collectChainBackwards(node);
        if (chain.length === 0) return;

        const errorIndex = chain.length - 1;
        const lastFromIndex = findLastFromIndex(chain, errorIndex);

        // No from() before this error() -- it's valid
        if (lastFromIndex === -1) return;

        context.report({
          node: node as Rule.Node,
          messageId: "errorAfterFrom",
        });
      },
    };
  },
};

export default rule;
