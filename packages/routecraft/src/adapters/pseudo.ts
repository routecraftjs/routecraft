import type { Exchange } from "../exchange.ts";
import type { Source } from "../operations/from.ts";
import type { Destination } from "../operations/to.ts";
import type { Processor } from "../operations/process.ts";

export interface PseudoOptions {
  runtime?: "throw" | "noop";
}

export interface PseudoKeyedOptions extends PseudoOptions {
  args: "keyed";
}

/* eslint-disable @typescript-eslint/no-explicit-any -- input position must accept any exchange for DSL assignability */
export type PseudoAdapter<R> = Source<R> &
  Destination<any, R> &
  Processor<any, R>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type PseudoFactory<Opts> = <R = unknown>(opts: Opts) => PseudoAdapter<R>;

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
  const noopProcess = <T>(exchange: Exchange<T>): Exchange<R> =>
    exchange as unknown as Exchange<R>;

  type SendFn = PseudoAdapter<R>["send"];
  type ProcessFn = PseudoAdapter<R>["process"];
  return {
    subscribe: fail as Source<R>["subscribe"],
    send: runtime === "noop" ? (noopSend as SendFn) : (fail as SendFn),
    process:
      runtime === "noop" ? (noopProcess as ProcessFn) : (fail as ProcessFn),
  };
}

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
