import { rcError } from "../error.ts";

declare const PORT_TYPE: unique symbol;

/**
 * A named, versioned capability a plugin provides and another requires.
 *
 * A plugin names a port, never a plugin, which is what lets a stranger
 * replace a first-party provider under their own name: the consumer asks
 * for "somewhere to keep continuations", not for "the SQLite plugin".
 *
 * The phantom `T` is invariant, so a `Port<Store>` cannot be required as a
 * `Port<unknown>` and read back as something it is not.
 *
 * @template T - What the provider hands its consumers
 */
export interface Port<T> {
  /** `owner.capability@version`, e.g. `routecraft.continuations@1`. */
  readonly name: string;
  /** Identity. Two tokens with one name in one application is `RC1103`. */
  readonly key: symbol;
  readonly [PORT_TYPE]?: (value: T) => T;
}

/** A port of any type, for collections that only compare identity. */
export type AnyPort = Pick<Port<never>, "name" | "key">;

/** Anything a port is looked up on: a plugin context, or a context. */
export interface PortLookup {
  lookup<T>(port: Port<T>): T | undefined;
}

const PORT_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*@[0-9]+$/;

/**
 * Declare a port.
 *
 * Call it once, at module scope, and export the result: the token is the
 * identity, so a second `port()` call with the same name is a different port
 * and the kernel refuses an application holding both (`RC1103`). That
 * refusal is what catches two copies of one contract module in a process,
 * the classic silent failure of plugin systems.
 *
 * @param name - `owner.capability@version`
 * @returns A frozen token
 * @throws RC1103 when the name is not `owner.capability@version`
 *
 * @example
 * ```ts
 * export const APPROVALS = port<ApprovalService>("acme.approvals@1");
 * ```
 */
export function port<T>(name: string): Port<T> {
  if (!PORT_NAME.test(name)) {
    throw rcError("RC1103", undefined, {
      message: `Port name "${name}" must be lowercase dotted segments followed by @ and a version, e.g. "acme.approvals@1".`,
    });
  }
  return Object.freeze({ name, key: Symbol(name) });
}
