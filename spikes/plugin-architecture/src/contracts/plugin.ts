import type { Contribution, ExchangeContribution } from "./interventions.ts";
import type { Token } from "./token.ts";

export interface Health {
  readonly up: boolean;
  readonly detail?: string;
}

export type EventName = string;
export type EventHandler = (payload: unknown) => void;
export interface Registration {
  dispose(): void;
}

/**
 * The entire privileged surface. If something is not reachable here, no
 * plugin can do it, which makes P1 checkable by reading one type rather than
 * auditing a package.
 */
export interface PluginContext {
  readonly id: string;

  provide<T>(token: Token<T>, value: T): void;
  require<T>(token: Token<T>): T;
  optional<T>(token: Token<T>): T | undefined;

  /** Observation seam. */
  on(event: EventName, handler: EventHandler): Registration;
  /**
   * Participation seam.
   *
   * The exchange overload carries its own type parameter. Without it the
   * `Contribution` union collapses to `ExchangeContribution<unknown>` at the
   * call site and the factory's return type stops being inferred, which the
   * spike hit immediately (SPIKE-F2).
   */
  contribute<T>(contribution: ExchangeContribution<T>): void;
  contribute(contribution: Contribution): void;

  onTeardown(fn: () => void | Promise<void>): void;
}

/**
 * One interface, tiered by declaration. A plugin implements the parts it
 * participates in and leaves the rest absent.
 */
export interface Plugin {
  readonly id: string;
  readonly dependsOn?: readonly string[];

  apply?(ctx: PluginContext): void | Promise<void>;
  start?(ctx: PluginContext): void | Promise<void>;
  health?(): Health | Promise<Health>;
  stop?(ctx: PluginContext): void | Promise<void>;
}
