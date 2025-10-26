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

function isLiteral(node: unknown): node is { type: "Literal"; value: unknown } {
  return isObject(node) && node["type"] === "Literal" && "value" in node;
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

// Utility: find the callee name for a CallExpression like obj.method()
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

// Utility: Walk back the chain to see if it originates from craft()
function originatesFromCraft(call: unknown): boolean {
  let current: unknown = call;
  while (isCallExpression(current)) {
    const callee = (current as Record<string, unknown>)["callee"] as unknown;
    if (isIdentifier(callee) && callee.name === "craft") return true;
    if (isMemberExpression(callee)) {
      current = callee["object"] as unknown;
      continue;
    }
    break;
  }
  return false;
}

// Utility: Check if the chain contains `.id("...")` before `.from(...)`
function hasIdBeforeFrom(node: unknown): boolean {
  // Traverse left along member chain gathering calls in order from left to right
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

  const calls = callsInReverse.reverse();
  // Track if we have seen a valid id before encountering from
  let seenValidId = false;
  for (const call of calls) {
    if (!isCallExpression(call)) continue;
    const name = getMemberCallName(call);
    if (name === "id") {
      const args = (call as Record<string, unknown>)["arguments"] as
        | unknown[]
        | undefined;
      const arg = Array.isArray(args) ? args[0] : undefined;
      if (
        arg &&
        isLiteral(arg) &&
        typeof arg.value === "string" &&
        arg.value.trim().length > 0
      ) {
        seenValidId = true;
      } else {
        // id exists but is invalid; still treat as missing
        seenValidId = false;
      }
    }
    if (name === "from") {
      return seenValidId;
    }
  }
  return false;
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Every route() must include a non-empty name for easier debugging, monitoring, and consistency.",
      recommended: false,
    },
    messages: {
      missingId:
        "require-named-route: Every route must call .id(<non-empty string>) before .from().",
    },
    schema: [],
    // no fixer
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = getMemberCallName(node);
        if (name !== "from") return;
        // We only care about chains that originate from craft()
        if (!originatesFromCraft(node)) return;
        if (!hasIdBeforeFrom(node)) {
          context.report({ node, messageId: "missingId" });
        }
      },
    };
  },
};

export default rule;
