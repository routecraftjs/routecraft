import type { Rule, Scope } from "eslint";
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

/** The first definition of the variable an identifier names, nearest scope first. */
function definitionOf(
  context: Rule.RuleContext,
  node: Rule.Node,
  identifier: { name: string },
): { found: boolean; def: Scope.Definition | undefined } {
  let scope: Scope.Scope | null = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.variables.find((v) => v.name === identifier.name);
    if (variable) return { found: true, def: variable.defs[0] };
    scope = scope.upper;
  }
  return { found: false, def: undefined };
}

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
  const { found, def } = definitionOf(context, node, identifier);
  if (!found) return { kind: "unresolved" };
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

/**
 * The module an identifier is imported from, whichever form the import
 * takes (named, default or namespace); `undefined` for any other binding.
 */
export function importSource(
  context: Rule.RuleContext,
  node: Rule.Node,
  identifier: { name: string },
): string | undefined {
  const { def } = definitionOf(context, node, identifier);
  if (def?.type !== "ImportBinding") return undefined;
  const source = def.parent.source.value;
  return typeof source === "string" ? source : undefined;
}

/**
 * Whether a module specifier names a file of the project itself: a relative
 * path, or one of the alias prefixes projects map onto their own source
 * (`@/`, `~/`, `#`). A bare package name is somebody else's code.
 */
export function isProjectModule(source: string): boolean {
  return (
    source.startsWith(".") ||
    source.startsWith("@/") ||
    source.startsWith("~/") ||
    source.startsWith("#")
  );
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
  const { def } = definitionOf(context, node, identifier);
  if (def?.type !== "Variable" || def.node.id.type !== "Identifier") {
    return undefined;
  }
  return def.node.init ?? undefined;
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
