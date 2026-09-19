import type { Exchange } from "./exchange.ts";

/** One unit of work in a route's step list. */
export interface Step {
  readonly label: string;
  run(exchange: Exchange): Promise<void> | void;
}

/** The composed pipeline a wrapper wraps. */
export type Pipeline = (exchange: Exchange) => Promise<void>;

/**
 * What a wrapper may see of the route it wraps.
 *
 * Deliberately narrow. Every field here is a privilege, and the register's
 * C1 finding is that a 21-field route definition is what lets core hard-code
 * the list of things that may intervene.
 */
export interface RouteView {
  readonly id: string;
  readonly stepLabels: readonly string[];
  /** Options the route author passed for this wrapper's id, if any. */
  optionsFor(wrapperId: string): unknown;
}

/** Produces exchanges. Implemented outside core, always. */
export interface Source<Body = unknown> {
  readonly label: string;
  subscribe(emit: (body: Body) => Promise<void>): Promise<() => void>;
}
