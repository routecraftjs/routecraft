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

function isBranded(obj: unknown, key: symbol): boolean {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<symbol, unknown>)[key] === true
  );
}

/** Returns true if the value is a CraftContext instance. */
export function isCraftContext(obj: unknown): boolean {
  return isBranded(obj, BRAND.CraftContext);
}

/** Returns true if the value is a Route (DefaultRoute) instance. */
export function isRoute(obj: unknown): boolean {
  return isBranded(obj, BRAND.DefaultRoute);
}

/** Returns true if the value is a RouteBuilder instance (has .build()). */
export function isRouteBuilder(obj: unknown): boolean {
  return isBranded(obj, BRAND.RouteBuilder);
}

/** Returns true if the value is a RouteDefinition (from craft().from().build()). */
export function isRouteDefinition(obj: unknown): boolean {
  return isBranded(obj, BRAND.RouteDefinition);
}

/** Returns true if the value is a RoutecraftError instance. */
export function isRoutecraftError(obj: unknown): boolean {
  return isBranded(obj, BRAND.RoutecraftError);
}

/** Returns true if the value is an Exchange instance. */
export function isExchange(obj: unknown): boolean {
  return isBranded(obj, BRAND.Exchange);
}
