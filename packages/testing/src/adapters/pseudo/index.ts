import type { Source, Destination, Processor } from "@routecraft/routecraft";
import type { PseudoOptions, PseudoKeyedOptions } from "./shared";

/**
 * @internal
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- input position must accept any exchange for DSL assignability */
export type PseudoAdapter<R> = {
  adapterId: string;
} & Source<R> &
  Destination<any, R> &
  Processor<any, R>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** @internal */
export type PseudoFactory<Opts> = <R = unknown>(opts: Opts) => PseudoAdapter<R>;

/** @internal */
export type PseudoKeyedFactory<Opts> = <R = unknown>(
  key: string,
  opts?: Opts,
) => PseudoAdapter<R>;

function createAdapter<R>(
  name: string,
  runtime: "throw" | "noop",
): PseudoAdapter<R> {
  const fail = (): never => {
    throw new Error(
      `Pseudo adapter "${name}" is not implemented. Replace with a real adapter.`,
    );
  };
  const noopSend = (): Promise<R> => Promise.resolve(undefined as unknown as R);
  const noopProcess = (exchange: unknown): unknown => exchange;
  const noopSubscribe = (
    _context: unknown,
    _handler: unknown,
    _abortController: unknown,
    onReady?: () => void,
  ): Promise<void> => {
    onReady?.();
    return Promise.resolve();
  };

  type SendFn = PseudoAdapter<R>["send"];
  type ProcessFn = PseudoAdapter<R>["process"];
  type SubscribeFn = Source<R>["subscribe"];

  return {
    adapterId: `routecraft.adapter.pseudo.${name}`,
    subscribe:
      runtime === "noop"
        ? (noopSubscribe as SubscribeFn)
        : (fail as SubscribeFn),
    send: runtime === "noop" ? (noopSend as SendFn) : (fail as SendFn),
    process:
      runtime === "noop" ? (noopProcess as ProcessFn) : (fail as ProcessFn),
  };
}

/**
 * Creates a pseudo (placeholder) adapter for use in tests or as a stub during development.
 *
 * @experimental
 */
// Overload: string-first (keyed) factory
export function pseudo<
  Opts extends Record<string, unknown> = Record<string, unknown>,
>(name: string, options: PseudoKeyedOptions): PseudoKeyedFactory<Opts>;

// Overload: object-only factory (default)
export function pseudo<
  Opts extends Record<string, unknown> = Record<string, unknown>,
>(name?: string, options?: PseudoOptions): PseudoFactory<Opts>;

// Implementation
export function pseudo<
  Opts extends Record<string, unknown> = Record<string, unknown>,
>(
  name = "pseudo",
  options?: PseudoOptions | PseudoKeyedOptions,
): PseudoFactory<Opts> | PseudoKeyedFactory<Opts> {
  const runtime = options?.runtime ?? "throw";
  const isKeyed = options && "args" in options && options.args === "keyed";

  if (isKeyed) {
    return <R = unknown>(key: string, opts?: Opts): PseudoAdapter<R> => {
      void key;
      void opts;
      return createAdapter<R>(name, runtime);
    };
  }
  return <R = unknown>(opts: Opts): PseudoAdapter<R> => {
    void opts;
    return createAdapter<R>(name, runtime);
  };
}

// Re-export types
export type { PseudoOptions, PseudoKeyedOptions } from "./shared";
