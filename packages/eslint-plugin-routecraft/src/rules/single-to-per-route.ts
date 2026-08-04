import type { Rule } from "eslint";
import {
  collectChainBackwards,
  isCallExpression,
  getMemberCallName,
  originatesFromCraft,
} from "./shared/ast.ts";

/**
 * Find the index of the last from() call before the given index in the chain.
 * Returns -1 if no from() is found.
 */
function findLastFromIndex(chain: unknown[], beforeIndex: number): number {
  for (let i = beforeIndex; i >= 0; i--) {
    const call = chain[i];
    if (isCallExpression(call) && getMemberCallName(call) === "from") {
      return i;
    }
  }
  return -1;
}

/**
 * Get indices of all .to() calls in the chain between lastFromIndex and endIndex (inclusive).
 */
function getToIndicesInSegment(
  chain: unknown[],
  lastFromIndex: number,
  endIndex: number,
): number[] {
  const indices: number[] = [];
  for (let i = lastFromIndex; i <= endIndex; i++) {
    if (isCallExpression(chain[i]) && getMemberCallName(chain[i]) === "to") {
      indices.push(i);
    }
  }
  return indices;
}

const rule: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Warn when multiple .to() operations are used in a single route. Prefer one .to() per route; use .enrich() or .tap() for intermediate steps.",
      recommended: false,
    },
    messages: {
      multipleToPerRoute:
        "single-to-per-route: Multiple .to() in one route. Prefer one .to() per route; consider .enrich() or .tap() for intermediate steps.",
    },
    schema: [],
  },
  create(context) {
    const reportedNodes = new Set<unknown>();

    return {
      CallExpression(node) {
        if (getMemberCallName(node) !== "to") return;
        if (!originatesFromCraft(node)) return;
        if (reportedNodes.has(node)) return;

        const chain = collectChainBackwards(node);
        if (chain.length === 0) return;

        const endIndex = chain.length - 1;
        const lastFromIndex = findLastFromIndex(chain, endIndex);

        // No .from() in chain (e.g. craft().to()) - skip
        if (lastFromIndex === -1) return;

        const toIndices = getToIndicesInSegment(chain, lastFromIndex, endIndex);

        if (toIndices.length <= 1) return;

        // Only report once per route - report on the last .to() in the chain
        const lastToIndex = toIndices[toIndices.length - 1];
        if (endIndex !== lastToIndex) return;

        // Mark all .to() nodes in this route as reported to avoid duplicates
        for (const idx of toIndices) {
          reportedNodes.add(chain[idx]);
        }

        context.report({
          node: node as Rule.Node,
          messageId: "multipleToPerRoute",
        });
      },
    };
  },
};

export default rule;
