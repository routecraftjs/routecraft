import type { Rule } from "eslint";
import {
  type CraftOrigins,
  isIdentifier,
  isLiteral,
  isMemberExpression,
  originatesFromCraft,
} from "./shared/ast.ts";

const ROUTECRAFT_MODULE = "@routecraft/routecraft";
const MINTING_EXPORTS = new Set(["authenticate", "markAuthentic"]);

/**
 * Resolve an identifier reference to the import binding that declares it,
 * when there is one in scope. Scope-based (not name-based) so a shadowing
 * parameter or local named `authenticate` is never confused with the
 * routecraft import, and so import order in the file is irrelevant (ESM
 * imports are hoisted).
 */
function resolveImport(
  context: Rule.RuleContext,
  node: Rule.Node,
  identifier: { name: string },
):
  | { module: string; imported: string; kind: "named" | "namespace" }
  | undefined {
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.variables.find((v) => v.name === identifier.name);
    if (variable) {
      const def = variable.defs[0];
      if (!def || def.type !== "ImportBinding") return undefined;
      const source = def.parent.source.value;
      if (typeof source !== "string") return undefined;
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
      return undefined;
    }
    scope = scope.upper as typeof scope;
  }
  return undefined;
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
 * from `craft()` (bare, aliased, or via a routecraft namespace import),
 * and calls to `authenticate` / `markAuthentic` reached through a
 * routecraft import (named, aliased, namespace member, or computed member
 * with a string literal). Helper bindings are resolved through scope, so a
 * same-named function from another module, or a shadowing local, is not
 * flagged. Knowingly uncovered laundering forms, all of which require code
 * that is itself review-visible: re-exporting the helpers from a local
 * module, `export *`, destructuring a namespace import, and assigning the
 * helper to another variable.
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
    // Craft-chain origin bindings, collected up front from the Program
    // node (imports are hoisted, so declaration order in the file must not
    // matter): locals bound to routecraft's `craft` export, routecraft
    // namespace locals, and locals imported from any OTHER module (used to
    // veto the bare-name `craft` fallback for foreign same-named imports).
    const craftNames = new Set<string>();
    const namespaces = new Set<string>();
    const foreignNames = new Set<string>();
    const origins: CraftOrigins = { craftNames, namespaces, foreignNames };

    return {
      Program(node) {
        for (const statement of node.body) {
          if (statement.type !== "ImportDeclaration") continue;
          const fromRoutecraft = statement.source.value === ROUTECRAFT_MODULE;
          for (const specifier of statement.specifiers) {
            if (!fromRoutecraft) {
              foreignNames.add(specifier.local.name);
              continue;
            }
            if (
              specifier.type === "ImportSpecifier" &&
              specifier.imported.type === "Identifier" &&
              specifier.imported.name === "craft"
            ) {
              craftNames.add(specifier.local.name);
            }
            if (specifier.type === "ImportNamespaceSpecifier") {
              namespaces.add(specifier.local.name);
            }
          }
        }
      },
      CallExpression(node) {
        const callee: unknown = node.callee;

        // authenticate(...) / markAuthentic(...) via a (possibly aliased)
        // named import, resolved through scope so shadowing locals and
        // same-named imports from other modules never match.
        if (isIdentifier(callee)) {
          const binding = resolveImport(context, node, callee);
          if (
            binding?.kind === "named" &&
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

        // ns.authenticate(...) and ns["authenticate"](...) via a
        // routecraft namespace import.
        const property: unknown = callee.property;
        const propertyName = callee.computed
          ? isLiteral(property) && typeof property.value === "string"
            ? property.value
            : undefined
          : isIdentifier(property)
            ? property.name
            : undefined;
        if (propertyName === undefined) return;

        if (isIdentifier(callee.object) && MINTING_EXPORTS.has(propertyName)) {
          const binding = resolveImport(
            context,
            node,
            callee.object as { name: string },
          );
          if (
            binding?.kind === "namespace" &&
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

        // .authenticate(...) as a route operation on a craft() chain.
        // Reported on the property identifier, NOT the whole chain
        // CallExpression: sibling rules report on the chain, but here the
        // documented sanctioning gesture is an eslint-disable-next-line
        // directly above the `.authenticate(` line, and that placement
        // only suppresses when the report is anchored on that line.
        if (
          !callee.computed &&
          propertyName === "authenticate" &&
          originatesFromCraft(node, origins)
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
