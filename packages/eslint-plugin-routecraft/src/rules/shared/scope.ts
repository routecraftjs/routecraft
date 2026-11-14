import type { Rule } from "eslint";
import { isIdentifier, isLiteral, isObject } from "./ast.ts";

export const ROUTECRAFT_MODULE = "@routecraft/routecraft";

/**
 * How an identifier resolves in its lexical scope: to an import binding
 * (with its module and imported name), to some other local binding (a
 * parameter, variable, or function, which therefore shadows any import),
 * or to nothing at all (an unresolved global).
 */
export type Resolution =
  | { kind: "named" | "namespace"; module: string; imported: string }
  | { kind: "other" }
  | { kind: "unresolved" };

/**
 * Resolve an identifier reference through the scope chain. Scope-based
 * (not name-based) so a shadowing parameter or local is never confused
 * with an import, and so import order in the file is irrelevant (ESM
 * imports are hoisted).
 */
export function resolveBinding(
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
 * Whether an identifier is the named routecraft export `name`, whatever
 * it was imported as.
 */
export function isRoutecraftExport(
  context: Rule.RuleContext,
  node: Rule.Node,
  identifier: unknown,
  name: string,
): boolean {
  if (!isIdentifier(identifier)) return false;
  const binding = resolveBinding(context, node, identifier);
  return (
    binding.kind === "named" &&
    binding.module === ROUTECRAFT_MODULE &&
    binding.imported === name
  );
}

/**
 * The initialiser of the variable an identifier names, when it is a plain
 * `const x = <init>`, `let` or `var` declaration; `undefined` for
 * anything else, a destructured binding included, whose initialiser is the
 * object it was taken from rather than the value it holds.
 */
export function variableInit(
  context: Rule.RuleContext,
  node: Rule.Node,
  identifier: { name: string },
): unknown {
  let scope: ReturnType<typeof context.sourceCode.getScope> | null =
    context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.variables.find((v) => v.name === identifier.name);
    if (variable) {
      const def = variable.defs[0];
      if (def?.type !== "Variable" || def.node.id.type !== "Identifier") {
        return undefined;
      }
      return def.node.init ?? undefined;
    }
    scope = scope.upper;
  }
  return undefined;
}

/**
 * Extract a member expression's property name, accepting a plain
 * identifier, a computed string literal or a template with no
 * substitutions (`obj.craft` / `obj["craft"]`), so quoting a property
 * never evades detection.
 */
export function memberPropertyName(callee: {
  computed: boolean;
  property: unknown;
}): string | undefined {
  if (callee.computed) {
    const key = callee.property;
    if (isLiteral(key)) {
      return typeof key.value === "string" ? key.value : undefined;
    }
    if (!isObject(key) || key["type"] !== "TemplateLiteral") return undefined;
    const quasis = key["quasis"] as { value: { cooked?: string } }[];
    return quasis.length === 1 ? quasis[0]!.value.cooked : undefined;
  }
  return isIdentifier(callee.property) ? callee.property.name : undefined;
}
