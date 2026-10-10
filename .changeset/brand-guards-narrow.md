---
"@routecraft/routecraft": patch
---

The brand guards `isRoutecraftError`, `isExchange`, `isCraftContext`, `isRoute`, `isRouteBuilder` and `isRouteDefinition` are type predicates. A caller that checked `isRoutecraftError(err)` and then read `err.rc` previously needed a cast, because the guard returned a plain `boolean`; it now narrows to `RoutecraftError`, and the other five narrow to `Exchange`, `CraftContext`, `Route`, `AnyRouteBuilder` and `RouteDefinition`. Runtime behaviour is unchanged.
