/**
 * Minimal ESTree-shaped type guards and chain helpers shared by the rules
 * in this plugin. Typed structurally on purpose to avoid an
 * `@types/estree` dependency (matching the deliberate choice recorded in
 * `capability-boundaries.ts`); each guard checks exactly the fields a rule
 * dereferences, nothing more.
 *
 * These previously lived as per-file copies in every rule. They encode one
 * thing, the AST shape of a `craft()` builder chain, and must stay in
 * lockstep across rules, so they live once here. Rule-specific chain
 * helpers (`hasIdBeforeFrom`, `findLastFromIndex`, ...) stay in their own
 * rule files.
 */

/** Non-null object check that narrows to an indexable record. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read a node's `type` discriminant without asserting a node shape. */
export function typeOf(node: unknown): string | undefined {
  return isObject(node) && typeof node["type"] === "string"
    ? node["type"]
    : undefined;
}

/** Narrow to an ESTree Identifier node carrying a name. */
export function isIdentifier(
  node: unknown,
): node is { type: "Identifier"; name: string } {
  return (
    isObject(node) &&
    node["type"] === "Identifier" &&
    typeof node["name"] === "string"
  );
}

/** Narrow to an ESTree Literal node carrying a value. */
export function isLiteral(
  node: unknown,
): node is { type: "Literal"; value: unknown } {
  return isObject(node) && node["type"] === "Literal" && "value" in node;
}

/** Narrow to an ESTree MemberExpression with object/property fields. */
export function isMemberExpression(node: unknown): node is {
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

/** Narrow to an ESTree CallExpression with callee and arguments. */
export function isCallExpression(
  node: unknown,
): node is { type: "CallExpression"; callee: unknown; arguments: unknown[] } {
  return (
    isObject(node) &&
    node["type"] === "CallExpression" &&
    Array.isArray(node["arguments"]) &&
    "callee" in node
  );
}

/** Find the callee name for a CallExpression like `obj.method()` or `fn()`. */
export function getMemberCallName(node: unknown): string | undefined {
  if (!isCallExpression(node)) return undefined;

  const callee = (node as Record<string, unknown>)["callee"] as unknown;

  if (isMemberExpression(callee) && !callee.computed) {
    if (isIdentifier(callee["property"])) {
      return (callee["property"] as { name: string }).name;
    }
  } else if (isIdentifier(callee)) {
    return callee.name;
  }

  return undefined;
}

/**
 * Collect a builder chain's calls in source order (leftmost first) by
 * walking the member chain backwards from the outermost call.
 */
export function collectChainBackwards(node: unknown): unknown[] {
  const callsInReverse: unknown[] = [];
  let current: unknown = node;

  while (isCallExpression(current)) {
    callsInReverse.push(current);
    const callee = (current as Record<string, unknown>)["callee"] as unknown;

    if (isMemberExpression(callee)) {
      current = callee["object"] as unknown;
    } else {
      break;
    }
  }

  return callsInReverse.reverse();
}

/**
 * Walk back a call chain to see if it originates from a bare `craft()`
 * identifier. Name-based on purpose: the convention rules that use this
 * treat any `craft()` chain as the Routecraft DSL. A rule that needs
 * lexical precision (aliased or namespace imports, shadowing) resolves the
 * chain root through scope itself, as `restrict-principal-minting` does.
 */
export function originatesFromCraft(call: unknown): boolean {
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
