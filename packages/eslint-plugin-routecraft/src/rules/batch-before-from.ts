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

// Utility Functions

/**
 * Get the method name from a CallExpression (e.g., "batch" from craft().batch())
 * Returns undefined if it's not a member call expression
 */
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

/**
 * Check if a call expression chain originates from craft()
 * Walks back through the chain to find the root call
 */
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

/**
 * Collect the chain of call expressions from node backwards to craft()
 * Returns the chain in left-to-right order (craft() to node)
 */
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

/**
 * Find the index of the most recent from() call before the given index
 * Returns -1 if no from() is found
 */
function findLastFromIndex(chain: unknown[], beforeIndex: number): number {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const call = chain[i];
    if (isCallExpression(call) && getMemberCallName(call) === "from") {
      return i;
    }
  }
  return -1;
}

/**
 * Check if there's a from() call after the given batch() node by walking up the AST
 * This determines if batch() is starting a new route in a multi-route chain
 */
function hasFromAfterBatch(batchNode: unknown): boolean {
  let current: unknown = batchNode;

  while (isObject(current) && "parent" in current) {
    const parent = current["parent"] as unknown;

    // If parent is a MemberExpression where current is the object
    if (
      isObject(parent) &&
      parent["type"] === "MemberExpression" &&
      (parent as Record<string, unknown>)["object"] === current
    ) {
      const property = (parent as Record<string, unknown>)["property"];

      // Check if the property is "from"
      if (isIdentifier(property) && property.name === "from") {
        return true;
      }

      // Move to the parent's parent (the CallExpression)
      if ("parent" in parent) {
        current = parent["parent"] as unknown;
        continue;
      }
    }
    break;
  }

  return false;
}

/**
 * Validate that a chain starts with craft() and ends with batch()
 */
function isValidCraftChain(chain: unknown[], expectedEndCall: string): boolean {
  if (chain.length === 0) return false;

  const firstCall = chain[0];
  const lastCall = chain[chain.length - 1];

  return (
    isCallExpression(firstCall) &&
    getMemberCallName(firstCall) === "craft" &&
    isCallExpression(lastCall) &&
    getMemberCallName(lastCall) === expectedEndCall
  );
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ensure batch() is used as a route-level operation (before from()).",
      recommended: false,
    },
    messages: {
      batchAfterFrom:
        "batch-before-from: batch() must be configured before from(); it is a route-level operation.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        // Only process batch() calls from craft() chains
        if (getMemberCallName(node) !== "batch") return;
        if (!originatesFromCraft(node)) return;

        // Collect and validate the chain
        const chain = collectChainBackwards(node);
        if (!isValidCraftChain(chain, "batch")) return;

        // Check if there's a from() before this batch()
        const batchIndex = chain.length - 1;
        const lastFromIndex = findLastFromIndex(chain, batchIndex);

        // If no from() before batch(), it's valid (route-level batch)
        if (lastFromIndex === -1) return;

        // If there's a from() before batch(), it's only valid if batch() starts a new route
        // (indicated by a from() call after it)
        const startsNewRoute = hasFromAfterBatch(node);
        if (startsNewRoute) return;

        // Report error: batch() is in the middle of a route
        context.report({
          node: node as Rule.Node,
          messageId: "batchAfterFrom",
        });
      },
    };
  },
};

export default rule;
