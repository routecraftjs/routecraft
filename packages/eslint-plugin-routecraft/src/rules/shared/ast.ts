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

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isIdentifier(
  node: unknown,
): node is { type: "Identifier"; name: string } {
  return (
    isObject(node) &&
    node["type"] === "Identifier" &&
    typeof node["name"] === "string"
  );
}

export function isLiteral(
  node: unknown,
): node is { type: "Literal"; value: unknown } {
  return isObject(node) && node["type"] === "Literal" && "value" in node;
}

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
 * Optional origin bindings for {@link originatesFromCraft}. When supplied,
 * a chain also counts as craft-originating when it walks back to a call of
 * one of `craftNames` (locals bound to the routecraft `craft` export,
 * covering aliased imports) or to `<namespace>.craft(...)` for one of
 * `namespaces` (namespace imports of routecraft).
 */
export interface CraftOrigins {
  craftNames?: ReadonlySet<string>;
  namespaces?: ReadonlySet<string>;
  /**
   * Local names bound by imports from modules OTHER than routecraft. A
   * bare identifier in this set never counts as a craft origin, so
   * `import { craft } from "some-other-lib"` does not make that module's
   * chains look like Routecraft DSL.
   */
  foreignNames?: ReadonlySet<string>;
}

/**
 * Walk back a call chain to see if it originates from `craft()`. Without
 * `origins`, only a bare identifier named `craft` matches (the historical
 * behaviour every rule shipped with); rules that track imports can pass
 * `origins` to also match aliased and namespace forms and to exclude a
 * `craft` binding that provably came from another module.
 */
export function originatesFromCraft(
  call: unknown,
  origins?: CraftOrigins,
): boolean {
  let current: unknown = call;
  while (isCallExpression(current)) {
    const callee = (current as Record<string, unknown>)["callee"] as unknown;
    if (
      isIdentifier(callee) &&
      (origins?.craftNames?.has(callee.name) ||
        (callee.name === "craft" && !origins?.foreignNames?.has(callee.name)))
    ) {
      return true;
    }
    if (
      isMemberExpression(callee) &&
      !callee.computed &&
      isIdentifier(callee.object) &&
      origins?.namespaces?.has(callee.object.name) &&
      isIdentifier(callee.property) &&
      callee.property.name === "craft"
    ) {
      return true;
    }
    if (isMemberExpression(callee)) {
      current = callee["object"] as unknown;
      continue;
    }
    break;
  }
  return false;
}
