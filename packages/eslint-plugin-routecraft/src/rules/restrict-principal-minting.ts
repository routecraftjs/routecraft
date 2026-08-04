import type { Rule } from "eslint";
import {
  isCallExpression,
  isIdentifier,
  isLiteral,
  isMemberExpression,
} from "./shared/ast.ts";

const ROUTECRAFT_MODULE = "@routecraft/routecraft";
const MINTING_EXPORTS = new Set(["authenticate", "markAuthentic"]);

/**
 * How an identifier resolves in its lexical scope: to an import binding
 * (with its module and imported name), to some other local binding (a
 * parameter, variable, or function, which therefore shadows any import),
 * or to nothing at all (an unresolved global).
 */
type Resolution =
  | { kind: "named" | "namespace"; module: string; imported: string }
  | { kind: "other" }
  | { kind: "unresolved" };

/**
 * Resolve an identifier reference through the scope chain. Scope-based
 * (not name-based) so a shadowing parameter or local is never confused
 * with an import, and so import order in the file is irrelevant (ESM
 * imports are hoisted).
 */
function resolveBinding(
  context: Rule.RuleContext,
  node: Rule.Node,
  identifier: { name: string },
): Resolution {
  let scope: ReturnType<typeof context.sourceCode.getScope> | null =
    context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.variables.find((v) => v.name === identifier.name);
    if (variable) {
      const def = variable.defs[0];
      if (!def || def.type !== "ImportBinding") return { kind: "other" };
      const source = def.parent.source.value;
      if (typeof source !== "string") return { kind: "other" };
      if (def.node.type === "ImportSpecifier") {
        const imported =
          def.node.imported.type === "Identifier"
            ? def.node.imported.name
            : String(def.node.imported.value);
        return { module: source, imported, kind: "named" };
      }
      if (def.node.type === "ImportNamespaceSpecifier") {
        return { module: source, imported: "*", kind: "namespace" };
      }
      return { kind: "other" };
    }
    scope = scope.upper;
  }
  return { kind: "unresolved" };
}

/**
 * Extract a member expression's property name, accepting a plain
 * identifier or a computed string literal (`obj.craft` / `obj["craft"]`),
 * so quoting a property never evades detection.
 */
function memberPropertyName(callee: {
  computed: boolean;
  property: unknown;
}): string | undefined {
  if (callee.computed) {
    return isLiteral(callee.property) &&
      typeof callee.property.value === "string"
      ? callee.property.value
      : undefined;
  }
  return isIdentifier(callee.property) ? callee.property.name : undefined;
}

/**
 * Walk a builder chain back to its innermost call and return that call's
 * callee node, e.g. the `craft` identifier or the `rc.craft` member of
 * `rc.craft().id("x").from(...)`.
 */
function chainRootCallee(call: unknown): unknown {
  let current: unknown = call;
  let root: unknown;
  while (isCallExpression(current)) {
    root = current.callee;
    if (isMemberExpression(root)) {
      current = root.object;
      continue;
    }
    break;
  }
  return root;
}

/**
 * Restrict principal minting to explicitly sanctioned sites.
 *
 * `.authenticate()` (and the `authenticate()` / `markAuthentic()` helpers)
 * produce an authenticity-branded principal that every downstream
 * `authorize()` trusts and that propagates across `direct()` calls. An
 * unreviewed mint anywhere in a codebase is therefore a
 * privilege-escalation vector: any route can fabricate an arbitrary
 * identity and forward it. Minting is a legitimate and necessary pattern
 * at channel boundaries (a mail route minting from a DKIM-verified
 * sender), so the operation cannot be banned outright; instead this rule
 * makes every mint site an explicit, reviewable exception. Sanction a
 * legitimate channel authenticator with a scoped disable comment carrying
 * a justification, or a per-file override in the ESLint config, so adding
 * a mint site is always a visible act in review.
 *
 * Detection is intentionally precise over exhaustive (lint is advisory,
 * not a sandbox): flagged are `.authenticate(...)` on chains originating
 * from `craft()` (bare, aliased, or via a routecraft namespace import,
 * with dotted or computed string-literal member access), and calls to
 * `authenticate` / `markAuthentic` reached through a routecraft import
 * (named, aliased, namespace member, or computed member with a string
 * literal). Bindings are resolved through scope, so a same-named function
 * from another module, or a shadowing local, is not flagged. Knowingly
 * uncovered laundering forms, all of which require code that is itself
 * review-visible: re-exporting the helpers from a local module,
 * `export *`, destructuring a namespace import, and assigning the helper
 * to another variable.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Principal minting (.authenticate(), authenticate(), markAuthentic()) is restricted to explicitly sanctioned channel authenticators.",
      recommended: true,
    },
    messages: {
      restrictedMint:
        "restrict-principal-minting: {{what}} mints a trusted principal that every downstream authorize() accepts. Minting is only legitimate at a sanctioned channel boundary; sanction this site explicitly with a scoped eslint-disable comment (with justification) or a per-file override in the ESLint config.",
    },
    schema: [],
    // no fixer: sanctioning must be a deliberate human act
  },
  create(context) {
    /**
     * Does this chain's root call resolve to routecraft's `craft`? The
     * root identifier (or namespace object) is classified by its lexical
     * binding: a routecraft import (aliased or not) counts, a namespace
     * member named `craft` counts, an unresolved global named `craft`
     * counts as a deliberate fallback (config snippets without imports),
     * and any other binding, including a shadowing parameter or local,
     * does not.
     */
    const originatesFromRoutecraftCraft = (node: Rule.Node): boolean => {
      const root = chainRootCallee(node);
      if (isIdentifier(root)) {
        const binding = resolveBinding(context, node, root);
        if (binding.kind === "named") {
          return (
            binding.module === ROUTECRAFT_MODULE && binding.imported === "craft"
          );
        }
        return binding.kind === "unresolved" && root.name === "craft";
      }
      if (isMemberExpression(root) && isIdentifier(root.object)) {
        if (memberPropertyName(root) !== "craft") return false;
        const binding = resolveBinding(context, node, root.object);
        return (
          binding.kind === "namespace" && binding.module === ROUTECRAFT_MODULE
        );
      }
      return false;
    };

    return {
      CallExpression(node) {
        const callee: unknown = node.callee;

        // authenticate(...) / markAuthentic(...) via a (possibly aliased)
        // named import, resolved through scope so shadowing locals and
        // same-named imports from other modules never match.
        if (isIdentifier(callee)) {
          const binding = resolveBinding(context, node, callee);
          if (
            binding.kind === "named" &&
            binding.module === ROUTECRAFT_MODULE &&
            MINTING_EXPORTS.has(binding.imported)
          ) {
            context.report({
              node,
              messageId: "restrictedMint",
              data: { what: `${binding.imported}()` },
            });
          }
          return;
        }

        if (!isMemberExpression(callee)) return;
        const propertyName = memberPropertyName(callee);
        if (propertyName === undefined) return;

        // ns.authenticate(...) and ns["authenticate"](...) via a
        // routecraft namespace import.
        if (isIdentifier(callee.object) && MINTING_EXPORTS.has(propertyName)) {
          const binding = resolveBinding(
            context,
            node,
            callee.object as { name: string },
          );
          if (
            binding.kind === "namespace" &&
            binding.module === ROUTECRAFT_MODULE
          ) {
            context.report({
              node,
              messageId: "restrictedMint",
              data: { what: `${propertyName}()` },
            });
            return;
          }
        }

        // .authenticate(...) (dotted or computed string literal) as a
        // route operation on a craft() chain. Reported on the property
        // node, NOT the whole chain CallExpression: sibling rules report
        // on the chain, but here the documented sanctioning gesture is a
        // scoped disable comment placed directly above the
        // `.authenticate(` line, and that placement only suppresses when
        // the report is anchored on that line.
        if (
          propertyName === "authenticate" &&
          originatesFromRoutecraftCraft(node)
        ) {
          context.report({
            node: callee.property as Rule.Node,
            messageId: "restrictedMint",
            data: { what: ".authenticate()" },
          });
        }
      },
    };
  },
};

export default rule;
