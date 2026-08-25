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
 * Coverage is syntactic and local to the resolver. Locals declared inside
 * it are tracked, including through destructuring and one local derived
 * from another, because naming a value before using it is how most people
 * write this. What is still NOT flagged is a value returned from a helper,
 * one closed over from outside the resolver, or an array assembled
 * elsewhere and passed by reference: those need data flow across scopes
 * that this rule does not attempt. The rule is a safety net over an opt-in
 * marker, never the enforcement itself, and the runtime applies flag
 * protection only to what the author actually marked.
 *
 * Nodes are narrowed structurally rather than through `@types/estree`,
 * matching the deliberate dependency choice recorded in `shared/ast.ts`.
 */

/**
 * Does this expression read from `param`, directly or through members?
 *
 * `tainted` carries the resolver's own locals that already hold an
 * exchange value. Without them the rule saw only the spelling nobody
 * writes: `const url = ex.body.url` is the natural way to name a value
 * before using it, and treating that local as clean made the rule blind
 * to the commonest shape of the very thing it exists to catch.
 */
function readsFrom(
  node: unknown,
  param: string,
  tainted: ReadonlySet<string>,
): boolean {
  if (!isObject(node)) return false;
  switch (typeOf(node)) {
    case "Identifier":
      return (
        isIdentifier(node) && (node.name === param || tainted.has(node.name))
      );
    case "MemberExpression":
      return readsFrom(node["object"], param, tainted);
    case "ChainExpression":
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "AwaitExpression":
      return readsFrom(node["expression"] ?? node["argument"], param, tainted);
    case "TemplateLiteral":
      return (
        Array.isArray(node["expressions"]) &&
        node["expressions"].some((e) => readsFrom(e, param, tainted))
      );
    case "BinaryExpression":
    case "LogicalExpression":
      // `ex.body.url ?? ""` and `ex.body.url || "origin"` are the ordinary
      // way an author supplies a fallback, so they must not read as safe.
      return (
        readsFrom(node["left"], param, tainted) ||
        readsFrom(node["right"], param, tainted)
      );
    case "ConditionalExpression":
      return (
        readsFrom(node["test"], param, tainted) ||
        readsFrom(node["consequent"], param, tainted) ||
        readsFrom(node["alternate"], param, tainted)
      );
    case "AssignmentExpression":
      // An assignment evaluates to its right side, so `a = b = ex.body.url`
      // hands the exchange value to `a` as well as to `b`.
      return readsFrom(node["right"], param, tainted);
    case "SequenceExpression": {
      // A comma expression evaluates to its last operand, and only that
      // operand reaches argv. Testing every operand would report
      // `(ex.body.log, "origin")`, which passes a literal.
      const expressions = node["expressions"];
      return (
        Array.isArray(expressions) &&
        readsFrom(expressions[expressions.length - 1], param, tainted)
      );
    }
    case "CallExpression":
      // Both halves matter. The callee chain carries the exchange for a
      // method call (`ex.body.url.trim()`, the most likely shape of all),
      // and an argument carries it for a wrapper (`String(ex.body.id)`).
      // A method's result is as attacker-influenced as its receiver.
      return (
        readsFrom(node["callee"], param, tainted) ||
        (Array.isArray(node["arguments"]) &&
          node["arguments"].some((a) => readsFrom(a, param, tainted)))
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
 * Names bound to an exchange-derived value inside the resolver.
 *
 * `const url = ex.body.url` names a value before using it, which is how
 * most people write this, and a rule that only sees the inline form
 * catches the spelling nobody uses. One pass is not enough because a
 * local can be derived from an earlier local, so this iterates until the
 * set stops growing; the number of declarations bounds the loop.
 *
 * Tainting is deliberately generous. A local reassigned to something safe
 * later still counts, because over-reporting costs an author one wrapper
 * on a value that did not need it, and under-reporting costs a silent
 * hole in the check that exists to catch exactly this.
 *
 * The walk stops at nested functions for the same reason the return walk
 * does: their locals are theirs.
 */
function collectTaintedLocals(
  body: unknown,
  param: string,
): ReadonlySet<string> {
  const declarations: { names: string[]; init: unknown }[] = [];
  gatherDeclarations(body, declarations);

  const tainted = new Set<string>();
  for (let pass = 0; pass < declarations.length; pass++) {
    let grew = false;
    for (const declaration of declarations) {
      if (declaration.names.every((name) => tainted.has(name))) continue;
      if (!readsFrom(declaration.init, param, tainted)) continue;
      for (const name of declaration.names) tainted.add(name);
      grew = true;
    }
    if (!grew) break;
  }
  return tainted;
}

/** Every binding in the resolver's own body: declarators and assignments alike. */
function gatherDeclarations(
  node: unknown,
  found: { names: string[]; init: unknown }[],
): void {
  if (!isObject(node)) return;
  switch (typeOf(node)) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return;
    case "VariableDeclarator": {
      const names: string[] = [];
      gatherBoundNames(node["id"], names);
      if (names.length > 0) found.push({ names, init: node["init"] });
      return;
    }
    case "AssignmentExpression": {
      // `let url; url = ex.body.url` binds the exchange as plainly as a
      // declarator does. Collecting only declarators left the rule blind
      // to it, which is the same one-spelling-covered-one-missed shape
      // this rule has already been caught by more than once.
      const names: string[] = [];
      gatherBoundNames(node["left"], names);
      if (names.length > 0) found.push({ names, init: node["right"] });
      // The right side can itself contain a declaration or a further
      // assignment (`a = b = ex.body.url`), so keep descending.
      gatherDeclarations(node["right"], found);
      return;
    }
    default:
      for (const key of DECLARATION_CHILD_KEYS) {
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) gatherDeclarations(item, found);
        } else if (isObject(child)) {
          gatherDeclarations(child, found);
        }
      }
  }
}

/**
 * Every name a binding target introduces.
 *
 * Destructuring is the other spelling of the same thing: `const { url } =
 * ex.body` binds an exchange value just as plainly as an assignment does,
 * so every name a pattern introduces is tainted together with it.
 */
function gatherBoundNames(node: unknown, names: string[]): void {
  if (!isObject(node)) return;
  switch (typeOf(node)) {
    case "Identifier":
      if (isIdentifier(node)) names.push(node.name);
      return;
    case "ObjectPattern":
      if (Array.isArray(node["properties"])) {
        for (const property of node["properties"]) {
          if (!isObject(property)) continue;
          gatherBoundNames(property["value"] ?? property["argument"], names);
        }
      }
      return;
    case "ArrayPattern":
      if (Array.isArray(node["elements"])) {
        for (const element of node["elements"])
          gatherBoundNames(element, names);
      }
      return;
    case "AssignmentPattern":
      gatherBoundNames(node["left"], names);
      return;
    case "RestElement":
      gatherBoundNames(node["argument"], names);
      return;
    default:
      return;
  }
}

/** Child slots a statement can hold a declaration in. */
const DECLARATION_CHILD_KEYS = [
  "body",
  "consequent",
  "alternate",
  "block",
  "handler",
  "finalizer",
  "cases",
  "declarations",
  "init",
  // An assignment reaches the walk through the statement wrapping it.
  "expression",
  "expressions",
] as const;

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
        const tainted = collectTaintedLocals(resolver["body"], param.name);
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
            if (!readsFrom(element, param.name, tainted)) continue;
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
