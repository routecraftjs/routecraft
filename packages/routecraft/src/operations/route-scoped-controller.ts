import type { Route } from "../route.ts";

/**
 * Base for a stateful operation that holds one piece of state PER ROUTE.
 *
 * A single step (or controller) instance is built once per `RouteDefinition`,
 * but that definition can be registered into multiple contexts, producing
 * several live `Route` instances. Keying the state by `Route` in a WeakMap
 * gives each Route its OWN state, so the contexts cannot cross-contaminate
 * each other (cross-sample, cross-suppress, cross-trip, cross-rate-limit).
 * A single `#routeless` fallback covers the route-less case (a step run in
 * isolation, e.g. a unit test) so behaviour stays bounded there too.
 *
 * Subclasses provide {@link createState}; the per-route lookup and lazy
 * creation live here once rather than being re-implemented per operation.
 *
 * @internal
 */
export abstract class RouteScopedController<S> {
  readonly #byRoute = new WeakMap<Route, S>();
  #routeless?: S;

  /**
   * Build a fresh state instance. Called at most once per Route (and once
   * for the route-less fallback), on first use.
   */
  protected abstract createState(): S;

  /**
   * Resolve the state for `route`, creating it on first use; or the shared
   * route-less instance when no Route is attached.
   */
  stateFor(route: Route | undefined): S {
    if (!route) return (this.#routeless ??= this.createState());
    let state = this.#byRoute.get(route);
    if (!state) {
      state = this.createState();
      this.#byRoute.set(route, state);
    }
    return state;
  }
}
