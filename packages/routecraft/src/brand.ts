/**
 * Cross-instance identity: Symbol.for() keys and type guards.
 * Shared across all copies of @routecraft/routecraft in a process (e.g. CLI vs user module).
 */

export const BRAND = {
  CraftContext: Symbol.for("routecraft.CraftContext"),
  DefaultRoute: Symbol.for("routecraft.DefaultRoute"),
  RouteBuilder: Symbol.for("routecraft.RouteBuilder"),
  RouteDefinition: Symbol.for("routecraft.RouteDefinition"),
  RoutecraftError: Symbol.for("routecraft.RoutecraftError"),
  Exchange: Symbol.for("routecraft.Exchange"),
  // Envelope brands: value objects (not class instances) marked with
  // `[brand]: true` so they survive crossing duplicate package copies.
  SplitChild: Symbol.for("routecraft.split.child"),
  Recovery: Symbol.for("routecraft.recovery"),
  /**
   * RESERVED for the adapter-sandbox `Secret` wrapper (#526). Nothing
   * brands it yet. The suspension serializer already refuses a value
   * carrying this brand, so the moment `Secret` starts applying it, "a
   * secret must never reach the suspension store" becomes enforced without
   * touching the serializer.
   */
  Secret: Symbol.for("routecraft.secret"),
  /**
   * The `Suspended` acknowledgment execution one answers with. Branded so a
   * transport recognises a parked exchange without shape-sniffing a body a
   * user route could also carry.
   */
  Suspended: Symbol.for("routecraft.suspended"),
  /**
   * An adapter that may raise a durable suspension from inside its own
   * execution (the agent tier's tool loop is the one shipped case). The
   * suspend-site walk assigns a re-entrant site to `.to()` / `.enrich()`
   * steps whose adapter carries this brand, so a runtime suspension from
   * such a step parks against a continuation that re-runs the step first.
   * Core owns the symbol; consumer packages mark their adapters with it and
   * never define their own.
   */
  SuspendCapable: Symbol.for("routecraft.adapter.suspendCapable"),
  /**
   * The throwable a suspend-capable adapter raises to park the exchange it
   * is executing. Converted into the ordinary `suspend` StepOutcome at the
   * step boundary (`.to()` / `.enrich()`), never propagated as a failure.
   */
  SuspendSignal: Symbol.for("routecraft.suspendSignal"),
} as const;

export const INTERNALS_KEY = Symbol.for("routecraft.exchange.internals");

/**
 * Type-only symbol used to mark enrich aggregators that declare a merge shape
 * (e.g. only(getValue, "links")). .enrich() infers result body as Current & that shape.
 * Not used at runtime.
 */
export const ENRICH_MERGE_TYPE: unique symbol = Symbol.for(
  "routecraft.EnrichMergeType",
) as never;

/**
 * Applies a brand symbol to an object so type guards (isCraftContext, isRoute, etc.) recognize it.
 *
 * @param obj - Object to brand (e.g. CraftContext, DefaultRoute, Exchange)
 * @param brand - Symbol from BRAND (e.g. BRAND.Exchange)
 */
export function setBrand(obj: object, brand: symbol): void {
  (obj as unknown as Record<symbol, boolean>)[brand] = true;
}

/**
 * Stores symbol-keyed internals on an object (e.g. exchange context/route). Not exposed on the public interface.
 *
 * @param obj - Object to attach internals to
 * @param key - Symbol key (e.g. INTERNALS_KEY)
 * @param value - Value to store
 */
export function setInternals<K extends symbol, V>(
  obj: object,
  key: K,
  value: V,
): void {
  (obj as unknown as Record<symbol, V>)[key] = value;
}

/**
 * Shared brand predicate: true when `obj` is an object carrying
 * `[key]: true`. The single implementation of the cross-instance
 * identity check; all guards in this module and the envelope guards
 * (`isSplitChild`, `isRecovery`) go through it so any future hardening
 * of the check lands once.
 *
 * @internal
 */
export function isBranded(obj: unknown, key: symbol): boolean {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<symbol, unknown>)[key] === true
  );
}

/**
 * Returns true if the value is a CraftContext instance.
 */
export function isCraftContext(obj: unknown): boolean {
  return isBranded(obj, BRAND.CraftContext);
}

/**
 * Returns true if the value is a Route (DefaultRoute) instance.
 */
export function isRoute(obj: unknown): boolean {
  return isBranded(obj, BRAND.DefaultRoute);
}

/**
 * Returns true if the value is a RouteBuilder instance (has .build()).
 */
export function isRouteBuilder(obj: unknown): boolean {
  return isBranded(obj, BRAND.RouteBuilder);
}

/**
 * Returns true if the value is a RouteDefinition (from craft().from().build()).
 */
export function isRouteDefinition(obj: unknown): boolean {
  return isBranded(obj, BRAND.RouteDefinition);
}

/**
 * Returns true if the value is a RoutecraftError instance.
 */
export function isRoutecraftError(obj: unknown): boolean {
  return isBranded(obj, BRAND.RoutecraftError);
}

/**
 * A RoutecraftError's RC code, or `undefined` for anything else.
 *
 * Lives beside the guard because every caller of one wants the other, and the
 * knowledge that the code sits on `.rc` was previously re-encoded as an
 * unchecked cast at each site. A cast fails silently when the field moves; one
 * reader fails loudly.
 */
export function rcCodeOf(error: unknown): string | undefined {
  return isRoutecraftError(error) ? (error as { rc?: string }).rc : undefined;
}

/**
 * Returns true if the value is an Exchange instance.
 */
export function isExchange(obj: unknown): boolean {
  return isBranded(obj, BRAND.Exchange);
}
