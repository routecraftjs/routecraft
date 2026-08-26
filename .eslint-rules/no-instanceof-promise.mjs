/**
 * ESLint rule banning `instanceof Promise` in framework source.
 *
 * The class and the contract are not the same set. `instanceof Promise`
 * misses a thenable a library hand-rolled, and misses a genuine native
 * `Promise` built in another realm, which carries a different intrinsic.
 * Standard Schema's `validate()` may return either, and gating on the class
 * silently skipped validation at five boundaries (#545).
 *
 * Scoped to `packages/*` source in `eslint.config.mjs`, not to the whole
 * tree: a sixth hand-rolled site would appear there, while build output and
 * vendored code are full of legitimate uses this rule has no business
 * reporting.
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban `instanceof Promise`; test for the thenable contract instead.",
      recommended: true,
    },
    schema: [],
    messages: {
      noInstanceofPromise:
        '`instanceof Promise` misses a hand-rolled thenable and a native Promise from another realm. Test the contract instead: `typeof value?.then === "function"`. Inside packages/routecraft, use isThenable from src/shared/thenable.ts; other packages keep a local copy, as packages/ai/src/llm/structured-output.ts does, because that helper is @internal and not exported.',
    },
  },
  create(context) {
    // `globalThis.Promise` is the same test written as a member expression,
    // and would otherwise pass unreported.
    const isPromiseRef = (node) =>
      (node.type === "Identifier" && node.name === "Promise") ||
      (node.type === "MemberExpression" &&
        !node.computed &&
        node.property.type === "Identifier" &&
        node.property.name === "Promise" &&
        node.object.type === "Identifier" &&
        (node.object.name === "globalThis" || node.object.name === "global"));

    return {
      BinaryExpression(node) {
        if (node.operator === "instanceof" && isPromiseRef(node.right)) {
          context.report({ node, messageId: "noInstanceofPromise" });
        }
      },
    };
  },
};
