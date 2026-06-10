import type { Exchange } from "@routecraft/routecraft";

export interface PseudoOptions {
  runtime?: "throw" | "noop";
}

export interface PseudoKeyedOptions extends PseudoOptions {
  args: "keyed";
}

/**
 * Creates a noop send function that resolves to undefined.
 */
export function createNoopSend<R>(): () => Promise<R> {
  return (): Promise<R> => Promise.resolve(undefined as unknown as R);
}

/**
 * Creates a noop process function that returns the exchange as-is.
 */
export function createNoopProcess<R>(): <T>(
  exchange: Exchange<T>,
) => Exchange<R> {
  return <T>(exchange: Exchange<T>): Exchange<R> =>
    exchange as unknown as Exchange<R>;
}

/**
 * Creates a noop subscribe function that signals readiness immediately.
 */
export function createNoopSubscribe(): (
  sub: import("@routecraft/routecraft").Subscription,
) => Promise<void> {
  return (sub): Promise<void> => {
    sub.ready();
    return Promise.resolve();
  };
}

/**
 * Creates a function that throws an error indicating the adapter is not implemented.
 */
export function createFailFunction(name: string): () => never {
  return (): never => {
    throw new Error(
      `Pseudo adapter "${name}" is not implemented. Replace with a real adapter.`,
    );
  };
}
