import type { Rule } from "eslint";
import {
  isCallExpression,
  isIdentifier,
  isObject,
  typeOf,
} from "./shared/ast.ts";

/**
 * Flag exchange-derived values passed to `shell()` without `untrusted()`.
 *
 * `shell()` spawns directly and never through a shell, so an argument can
 * never become a command. What it can still do is pose as an option to the
 * program being run: a `url` of `--upload-pack=...` handed to `git clone`
 * is honoured by `git`. `untrusted()` turns flag protection on for a value,
 * and it is per value because applying it to a whole argv would destroy the
 * author's own flags.
 *
 * That design has one cost, which this rule exists to cover: an author who
 * forgets to mark a value gets no protection and no error. The pattern is
 * mechanically recognisable, so the linter can say so.
 *
 * ## What it does not see
 *
 * Coverage is syntactic and local to the resolver. A value read into a
 * local first (`const url = ex.body.url`), returned from a helper, or
 * assembled in an array built elsewhere and passed by reference is NOT
 * flagged: tracking those needs data flow this rule does not attempt. The
 * rule is a safety net over an opt-in marker, never the enforcement
 * itself, and the runtime applies flag protection only to what the author
 * actually marked.
 *
 * Nodes are narrowed structurally rather than through `@types/estree`,
 * matching the deliberate dependency choice recorded in `shared/ast.ts`.
 */

/** Does this expression read from `param`, directly or through members? */
function readsFrom(node: unknown, param: string): boolean {
  if (!isObject(node)) return false;
  switch (typeOf(node)) {
    case "Identifier":
      return isIdentifier(node) && node.name === param;
    case "MemberExpression":
      return readsFrom(node["object"], param);
    case "ChainExpression":
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "AwaitExpression":
      return readsFrom(node["expression"] ?? node["argument"], param);
    case "TemplateLiteral":
      return (
        Array.isArray(node["expressions"]) &&
        node["expressions"].some((e) => readsFrom(e, param))
      );
    case "BinaryExpression":
    case "LogicalExpression":
      // `ex.body.url ?? ""` and `ex.body.url || "origin"` are the ordinary
      // way an author supplies a fallback, so they must not read as safe.
      return readsFrom(node["left"], param) || readsFrom(node["right"], param);
    case "ConditionalExpression":
      return (
        readsFrom(node["test"], param) ||
        readsFrom(node["consequent"], param) ||
        readsFrom(node["alternate"], param)
      );
    case "CallExpression":
      // Both halves matter. The callee chain carries the exchange for a
      // method call (`ex.body.url.trim()`, the most likely shape of all),
      // and an argument carries it for a wrapper (`String(ex.body.id)`).
      // A method's result is as attacker-influenced as its receiver.
      return (
        readsFrom(node["callee"], param) ||
        (Array.isArray(node["arguments"]) &&
          node["arguments"].some((a) => readsFrom(a, param)))
      );
    default:
      return false;
  }
}

/**
 * Is this a call to the shell adapter's `untrusted()`?
 *
 * The name alone is not enough. A local `function untrusted(v) { return v }`
 * would otherwise silence the rule on an argument that carries no
 * protection at all, which is worse than no rule: the author is told they
 * are covered. The identifier is resolved from the use site's own scope and
 * accepted only when it is an import of the marker itself.
 *
 * Two spellings defeat a laxer version of this check, and both are tested.
 * A binding declared inside the resolver shadows the import at the use site
 * while an outward-only walk still finds the import, and an alias
 * (`import { somethingElse as untrusted }`) satisfies a module-only test
 * while carrying no protection. The scope is therefore the element's own,
 * and the imported name is checked, not just the module it came from.
 */
function isUntrustedCall(node: unknown, scope: Scope): boolean {
  if (!isCallExpression(node) || !isIdentifier(node.callee)) return false;
  if (node.callee.name !== "untrusted") return false;
  const variable = findVariable(scope, "untrusted");
  // Unresolved means no binding is visible here: either the import is
  // missing (the code would not run) or the linter cannot see it. Accept
  // it rather than reporting a false positive on correct code.
  if (!variable) return true;
  return variable.defs.some(
    (def) =>
      def.type === "ImportBinding" &&
      typeof def.parent?.source?.value === "string" &&
      UNTRUSTED_MODULES.has(def.parent.source.value) &&
      // A default or namespace import is never the marker: the package has
      // no default export, so only a named import of `untrusted` counts.
      def.node?.type === "ImportSpecifier" &&
      def.node.imported?.name === UNTRUSTED_EXPORT,
  );
}

/** The export name that actually carries flag-injection protection. */
const UNTRUSTED_EXPORT = "untrusted";

/** Packages whose `untrusted` export is the real marker. */
const UNTRUSTED_MODULES = new Set(["@routecraft/os"]);

/** The subset of ESLint's scope objects this rule reads. */
interface Scope {
  variables: { name: string; defs: VariableDef[] }[];
  upper: Scope | null;
}

interface VariableDef {
  type: string;
  node?: { type?: string; imported?: { name?: unknown } };
  parent?: { source?: { value?: unknown } };
}

/** Walk outwards for the binding a bare identifier resolves to. */
function findVariable(
  scope: Scope | null,
  name: string,
): { defs: VariableDef[] } | undefined {
  for (let current = scope; current; current = current.upper) {
    const found = current.variables.find((v) => v.name === name);
    if (found) return found;
  }
  return undefined;
}

/**
 * Every array literal reachable as a return value of the resolver.
 *
 * Walks nested statements rather than only a block's direct children: an
 * early `if (...) return [...]` is the ordinary way a resolver branches,
 * and treating it as unreachable made the rule silent on exactly the form
 * most likely to carry a conditional argument.
 *
 * The walk stops at a nested function, whose returns belong to it and not
 * to the resolver. Descending into one reported a helper's argv as though
 * the resolver had returned it, which is a false positive on code that is
 * correct.
 */
function collectReturnedArrays(node: unknown, found: unknown[]): void {
  if (!isObject(node)) return;
  switch (typeOf(node)) {
    case "ArrayExpression":
      found.push(node);
      return;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return;
    case "ReturnStatement":
      collectReturnedArrays(node["argument"], found);
      return;
    case "ConditionalExpression":
      collectReturnedArrays(node["consequent"], found);
      collectReturnedArrays(node["alternate"], found);
      return;
    case "LogicalExpression":
      collectReturnedArrays(node["left"], found);
      collectReturnedArrays(node["right"], found);
      return;
    default:
      // Any other statement may still contain a return further down (an
      // if, a loop, a try, a switch case), so descend through its own
      // child nodes rather than enumerating every statement type.
      for (const key of STATEMENT_CHILD_KEYS) {
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) collectReturnedArrays(item, found);
        } else if (isObject(child)) {
          collectReturnedArrays(child, found);
        }
      }
  }
}

/** Child slots a statement can hold another statement in. */
const STATEMENT_CHILD_KEYS = [
  "body",
  "consequent",
  "alternate",
  "block",
  "handler",
  "finalizer",
  "cases",
] as const;

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require untrusted() around exchange-derived values in shell() arguments, so they cannot pose as options to the command.",
      recommended: true,
    },
    schema: [],
    messages: {
      unmarked:
        'This shell() argument comes from the exchange but is not wrapped in untrusted(), so flag-injection protection does not apply to it. A value of "--upload-pack=..." would be honoured by the program as its own option. Wrap it: untrusted({{ source }}).',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        if (!isIdentifier(node.callee) || node.callee.name !== "shell") return;

        const resolver: unknown = node.arguments[1];
        const resolverType = typeOf(resolver);
        if (
          resolverType !== "ArrowFunctionExpression" &&
          resolverType !== "FunctionExpression"
        ) {
          return;
        }
        if (!isObject(resolver) || !Array.isArray(resolver["params"])) return;

        // Only the exchange parameter marks a value as coming from outside.
        // A resolver that ignores its argument builds its arguments from
        // the author's own code, which needs no marking.
        const param: unknown = resolver["params"][0];
        if (!isIdentifier(param)) return;

        // The resolver's own scope, not the call site's. A binding declared
        // inside the resolver shadows the import there, and resolving from
        // outside would find the import the shadow has already displaced.
        const scope = context.sourceCode.getScope(
          resolver as never,
        ) as unknown as Scope;
        const arrays: unknown[] = [];
        collectReturnedArrays(resolver["body"], arrays);

        for (const array of arrays) {
          if (!isObject(array) || !Array.isArray(array["elements"])) continue;
          for (const raw of array["elements"]) {
            if (!isObject(raw)) continue;
            // A spread expands into arguments, so what it spreads is as
            // able to pose as an option as any element written out.
            const element =
              raw["type"] === "SpreadElement" && isObject(raw["argument"])
                ? raw["argument"]
                : raw;
            if (isUntrustedCall(element, scope)) continue;
            if (!readsFrom(element, param.name)) continue;
            context.report({
              node: element as never,
              messageId: "unmarked",
              data: { source: context.sourceCode.getText(element as never) },
            });
          }
        }
      },
    };
  },
};

export default rule;
