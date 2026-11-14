import type { Rule } from "eslint";
import {
  isCallExpression,
  isIdentifier,
  isMemberExpression,
  isObject,
} from "./shared/ast.ts";
import {
  isRoutecraftExport as routecraftExport,
  memberPropertyName,
  resolveBinding,
  variableInit,
} from "./shared/scope.ts";

const FACADE_ACTS: Readonly<Record<string, string>> = {
  mintToken: "restrictedMint",
  resume: "restrictedResume",
  rewriteStepState: "restrictedRewrite",
};
const SANCTION =
  "Sanction this site explicitly with a scoped eslint-disable comment (with justification) or a per-file override in the ESLint config.";
const WRAPPERS = new Set([
  "ChainExpression",
  "TSNonNullExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

/** The expression under an optional chain, a non-null assertion or a cast. */
function unwrap(expression: unknown): unknown {
  let current = expression;
  while (
    isObject(current) &&
    typeof current["type"] === "string" &&
    WRAPPERS.has(current["type"])
  ) {
    current = current["expression"];
  }
  return current;
}

/**
 * Restrict the acts on a parked exchange to explicitly sanctioned sites.
 *
 * A resume token is a capability: whoever holds one can present it at a
 * resume door. `continuations.resume()` revives a parked exchange with no
 * door at all, and `rewriteStepState()` edits what a step will be handed
 * when it runs again. Code in the process is trusted, so none of these is
 * forbidden; each is a decision, and this rule makes the call site visible
 * in review. Sanction a legitimate site with a scoped disable comment
 * carrying a justification, or a per-file override in the ESLint config.
 *
 * Flagged, direct forms only (lint is advisory, not a sandbox):
 *
 * - `<x>.continuations.mintToken(...)`, `.resume(...)` and
 *   `.rewriteStepState(...)`, on a member named `continuations`, a local
 *   named `continuations`, or a variable initialised from one
 * - `<x>.deferral.tokenFor(...)` and `deferralOf(exchange).tokenFor(...)`,
 *   which mint a token for a call binding
 * - `<signer>.mint(...)` where the signer is the `signer` of
 *   `require(CONTINUATIONS)` / `lookup(CONTINUATIONS)`, or a variable
 *   holding either
 *
 * Not flagged: reading `ex.deferral.token` or `Deferred.token`, the
 * documented way for a route to send a link to its own deferral. Knowingly
 * uncovered: a facade kept under another name on an object of your own, and
 * a helper that wraps one of the calls. Both need code that is itself
 * visible in review.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Minting a resume token, resuming with no door and rewriting stored step state are restricted to explicitly sanctioned sites.",
      recommended: true,
    },
    messages: {
      restrictedMint: `restrict-continuation-minting: {{what}} mints a resume token, and whoever holds one can present it at a resume door. ${SANCTION}`,
      restrictedResume: `restrict-continuation-minting: {{what}} resumes a parked exchange with no door, so no door policy runs. ${SANCTION}`,
      restrictedRewrite: `restrict-continuation-minting: {{what}} rewrites what a parked step is handed when it runs again. ${SANCTION}`,
    },
    schema: [],
    // no fixer: sanctioning must be a deliberate human act
  },
  create(context) {
    const isRoutecraftExport = (
      node: Rule.Node,
      identifier: unknown,
      name: string,
    ): boolean => routecraftExport(context, node, identifier, name);

    // Aliases already followed, so `var a = b, b = a` ends instead of recursing.
    const followed = new Set<unknown>();
    const aliasOf = (node: Rule.Node, identifier: { name: string }) => {
      const init = variableInit(context, node, identifier);
      if (init === undefined || followed.has(init)) return undefined;
      followed.add(init);
      return init;
    };

    /** `<x>.continuations`, a local named `continuations`, or a variable holding the former. */
    const isFacade = (node: Rule.Node, wrapped: unknown): boolean => {
      const expression = unwrap(wrapped);
      if (isMemberExpression(expression)) {
        return memberPropertyName(expression) === "continuations";
      }
      if (!isIdentifier(expression)) return false;
      const init = aliasOf(node, expression);
      if (init !== undefined) return isFacade(node, init);
      if (expression.name !== "continuations") return false;
      // An import of that name from somewhere else is somebody else's object.
      return resolveBinding(context, node, expression).kind === "other";
    };

    /** `x.require(CONTINUATIONS)` / `x.lookup(CONTINUATIONS)`, or a `const` holding one. */
    const isRuntime = (node: Rule.Node, wrapped: unknown): boolean => {
      const expression = unwrap(wrapped);
      if (isIdentifier(expression)) {
        const init = aliasOf(node, expression);
        return init !== undefined && isRuntime(node, init);
      }
      if (!isCallExpression(expression)) return false;
      const callee: unknown = expression.callee;
      if (!isMemberExpression(callee)) return false;
      const method = memberPropertyName(callee);
      return (
        (method === "require" || method === "lookup") &&
        isRoutecraftExport(node, expression.arguments[0], "CONTINUATIONS")
      );
    };

    /** The `signer` of the continuations runtime, or a `const` holding it. */
    const isSigner = (node: Rule.Node, wrapped: unknown): boolean => {
      const expression = unwrap(wrapped);
      if (isIdentifier(expression)) {
        const init = aliasOf(node, expression);
        return init !== undefined && isSigner(node, init);
      }
      if (!isMemberExpression(expression)) return false;
      return (
        memberPropertyName(expression) === "signer" &&
        isRuntime(node, expression.object)
      );
    };

    /** `<x>.deferral`, or `deferralOf(exchange)`, which returns the same facet. */
    const isDeferralFacet = (node: Rule.Node, wrapped: unknown): boolean => {
      const expression = unwrap(wrapped);
      if (isCallExpression(expression)) {
        return isRoutecraftExport(node, expression.callee, "deferralOf");
      }
      return (
        isMemberExpression(expression) &&
        memberPropertyName(expression) === "deferral"
      );
    };

    return {
      CallExpression(node) {
        followed.clear();
        const callee: unknown = node.callee;
        if (!isMemberExpression(callee)) return;
        const method = memberPropertyName(callee);
        if (method === undefined) return;
        const report = (messageId: string, what: string): void => {
          context.report({
            node: callee.property as Rule.Node,
            messageId,
            data: { what },
          });
        };

        const facadeAct = Object.hasOwn(FACADE_ACTS, method)
          ? FACADE_ACTS[method]
          : undefined;
        if (facadeAct !== undefined && isFacade(node, callee.object)) {
          report(facadeAct, `continuations.${method}()`);
          return;
        }
        if (method === "tokenFor" && isDeferralFacet(node, callee.object)) {
          report("restrictedMint", "deferral.tokenFor()");
          return;
        }
        if (method === "mint" && isSigner(node, callee.object)) {
          report("restrictedMint", "signer.mint()");
        }
      },
    };
  },
};

export default rule;
