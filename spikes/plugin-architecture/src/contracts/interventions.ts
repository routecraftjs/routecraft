import type { Exchange, ExchangeExtensionFactory } from "./exchange.ts";
import type { Pipeline, RouteView, Step } from "./route.ts";

/**
 * Where a plugin may intervene in a run.
 *
 * Closed on purpose. A new kind of point means a different exchange
 * lifecycle, which is a core change by definition. Everything inside a point
 * is open and unbounded.
 */
export type InterventionPoint = "wrapper" | "step" | "handler" | "exchange";

/**
 * Wraps the pipeline. Position is declared relative to other wrappers rather
 * than fixed by core, which is what replaces the hard-coded pre-from chain.
 */
export interface WrapperContribution {
  readonly kind: "wrapper";
  readonly id: string;
  /** This wrapper runs outside the named ones. */
  readonly before?: readonly string[];
  /** This wrapper runs inside the named ones. */
  readonly after?: readonly string[];
  wrap(next: Pipeline, route: RouteView): Pipeline;
}

/** Adds a named operation to the builder. */
export interface StepContribution {
  readonly kind: "step";
  readonly name: string;
  factory(...args: readonly unknown[]): Step;
}

export type HandlerPoint = "entry" | "error" | "complete";

/** Hooks an exchange lifecycle transition. */
export interface HandlerContribution {
  readonly kind: "handler";
  readonly id: string;
  readonly point: HandlerPoint;
  handle(exchange: Exchange, error?: unknown): Promise<void> | void;
}

/** Attaches plugin state to every exchange, reachable through `ex.use`. */
export interface ExchangeContribution<T = unknown> {
  readonly kind: "exchange";
  readonly id: string;
  readonly factory: ExchangeExtensionFactory<T>;
}

export type Contribution =
  | WrapperContribution
  | StepContribution
  | HandlerContribution
  | ExchangeContribution;
