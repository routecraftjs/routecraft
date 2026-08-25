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

/** Is this an `untrusted(...)` call? */
function isUntrustedCall(node: unknown): boolean {
  return isCallExpression(node) && isIdentifier(node.callee)
    ? node.callee.name === "untrusted"
    : false;
}

/** Every array literal reachable as a return value of the resolver. */
function collectReturnedArrays(body: unknown, found: unknown[]): void {
  if (!isObject(body)) return;
  switch (typeOf(body)) {
    case "ArrayExpression":
      found.push(body);
      return;
    case "BlockStatement":
      if (!Array.isArray(body["body"])) return;
      for (const statement of body["body"]) {
        if (
          isObject(statement) &&
          statement["type"] === "ReturnStatement" &&
          statement["argument"]
        ) {
          collectReturnedArrays(statement["argument"], found);
        }
      }
      return;
    case "ConditionalExpression":
      collectReturnedArrays(body["consequent"], found);
      collectReturnedArrays(body["alternate"], found);
      return;
    default:
  }
}

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

        const arrays: unknown[] = [];
        collectReturnedArrays(resolver["body"], arrays);

        for (const array of arrays) {
          if (!isObject(array) || !Array.isArray(array["elements"])) continue;
          for (const element of array["elements"]) {
            if (!isObject(element)) continue;
            if (element["type"] === "SpreadElement") continue;
            if (isUntrustedCall(element)) continue;
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
