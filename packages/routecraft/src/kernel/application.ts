import type { CraftContext } from "../context.ts";
import { type Exchange, getExchangeContext } from "../exchange.ts";

declare const APPLICATION_BRAND: unique symbol;

/**
 * An opaque value naming one application. It has no members: a plugin
 * module keys its own per-application state by it (a `WeakMap`), written in
 * `bind` under `c.application` and read by its adapters through
 * {@link applicationOf}. Two applications in one process, two
 * `testContext()` builds included, stay apart without a module singleton
 * and without handing every adapter the whole context.
 */
export interface ApplicationKey {
  readonly [APPLICATION_BRAND]: never;
}

const keys = new WeakMap<CraftContext, ApplicationKey>();

/** @internal */
export function applicationKeyFor(context: CraftContext): ApplicationKey {
  let key = keys.get(context);
  if (key === undefined) {
    key = Object.freeze({}) as ApplicationKey;
    keys.set(context, key);
  }
  return key;
}

/**
 * The application an exchange runs in, or `undefined` for an exchange built
 * by hand outside one.
 */
export function applicationOf(exchange: Exchange): ApplicationKey | undefined {
  const context = getExchangeContext(exchange);
  return context && applicationKeyFor(context);
}
