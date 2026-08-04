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

const ROUTECRAFT_MODULE = "@routecraft/routecraft";
const MINTING_EXPORTS = new Set(["authenticate", "markAuthentic"]);

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
 * not a sandbox): flagged are `.authenticate(...)` on chains that
 * provably originate from `craft()`, and calls to `authenticate` /
 * `markAuthentic` imported (directly, aliased, or via namespace) from
 * `@routecraft/routecraft`. A same-named function from another module is
 * not flagged.
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
    // Local names bound to the routecraft minting exports, e.g.
    // `authenticate`, `authenticate as mint`. Maps local name -> imported name.
    const mintingLocals = new Map<string, string>();
    // Local names of `import * as ns from "@routecraft/routecraft"`.
    const namespaceLocals = new Set<string>();

    return {
      ImportDeclaration(node) {
        if (node.source.value !== ROUTECRAFT_MODULE) return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            MINTING_EXPORTS.has(specifier.imported.name)
          ) {
            mintingLocals.set(specifier.local.name, specifier.imported.name);
          }
          if (specifier.type === "ImportNamespaceSpecifier") {
            namespaceLocals.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const callee: unknown = node.callee;

        // authenticate(...) / markAuthentic(...) via named (possibly
        // aliased) import from @routecraft/routecraft.
        if (isIdentifier(callee)) {
          const imported = mintingLocals.get(callee.name);
          if (imported) {
            context.report({
              node,
              messageId: "restrictedMint",
              data: { what: `${imported}()` },
            });
          }
          return;
        }

        if (!isMemberExpression(callee) || callee.computed) return;
        const property: unknown = callee.property;
        if (!isIdentifier(property)) return;

        // ns.authenticate(...) / ns.markAuthentic(...) via namespace import.
        if (
          isIdentifier(callee.object) &&
          namespaceLocals.has(callee.object.name) &&
          MINTING_EXPORTS.has(property.name)
        ) {
          context.report({
            node,
            messageId: "restrictedMint",
            data: { what: `${property.name}()` },
          });
          return;
        }

        // .authenticate(...) as a route operation on a craft() chain.
        if (property.name === "authenticate" && originatesFromCraft(node)) {
          context.report({
            node,
            messageId: "restrictedMint",
            data: { what: ".authenticate()" },
          });
        }
      },
    };
  },
};

export default rule;
