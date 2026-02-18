/**
 * Cross-instance identity: Symbol.for() keys and type guards.
 * Shared across all copies of @routecraft/routecraft in a process (e.g. CLI vs user module).
 */

export const BRAND = {
  CraftContext: Symbol.for("routecraft.CraftContext"),
  DefaultRoute: Symbol.for("routecraft.DefaultRoute"),
  RouteBuilder: Symbol.for("routecraft.RouteBuilder"),
  RouteDefinition: Symbol.for("routecraft.RouteDefinition"),
  RouteCraftError: Symbol.for("routecraft.RouteCraftError"),
  Exchange: Symbol.for("routecraft.Exchange"),
} as const;

export const INTERNALS_KEY = Symbol.for("routecraft.exchange.internals");

function isBranded(obj: unknown, key: symbol): boolean {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<symbol, unknown>)[key] === true
  );
}

export function isCraftContext(obj: unknown): boolean {
  return isBranded(obj, BRAND.CraftContext);
}

export function isRoute(obj: unknown): boolean {
  return isBranded(obj, BRAND.DefaultRoute);
}

export function isRouteBuilder(obj: unknown): boolean {
  return isBranded(obj, BRAND.RouteBuilder);
}

export function isRouteDefinition(obj: unknown): boolean {
  return isBranded(obj, BRAND.RouteDefinition);
}

export function isRouteCraftError(obj: unknown): boolean {
  return isBranded(obj, BRAND.RouteCraftError);
}

export function isExchange(obj: unknown): boolean {
  return isBranded(obj, BRAND.Exchange);
}
