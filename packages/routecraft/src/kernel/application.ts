import type { CraftContext } from "../context.ts";
import { type Exchange, getExchangeContext } from "../exchange.ts";
import type { Port } from "./port.ts";

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

/**
 * The provider of a port in the application an exchange runs in, or
 * `undefined` when none provides it or the exchange was built outside one.
 * What an adapter calls to reach what a plugin provides: it resolves the
 * way `context.lookup(port)` does, so a plugin that replaces the port is
 * the one an adapter gets.
 */
export function lookupOf<T>(exchange: Exchange, port: Port<T>): T | undefined {
  return getExchangeContext(exchange)?.lookup(port);
}

/** One plugin module's state, kept per application. See {@link applicationState}. */
export interface ApplicationState<T> {
  /** Keep `value` for an application. A plugin calls it in `bind` with `c.application`. */
  set(application: ApplicationKey, value: T): void;
  get(application: ApplicationKey | undefined): T | undefined;
  /** What the application an exchange runs in holds, for an adapter. */
  of(exchange: Exchange): T | undefined;
}

/**
 * Per-application state for a plugin module: the plugin writes it in
 * `bind`, its adapters read it from the exchange they are handed. It is a
 * `WeakMap` keyed by {@link ApplicationKey}, so the state goes with the
 * application.
 *
 * For state private to one module. A value another plugin may use or
 * replace is a port, read with {@link lookupOf}: this holder knows nothing
 * of `replaces`.
 *
 * @example
 * ```ts
 * const clients = applicationState<Client>()
 *
 * export const acme = definePlugin({
 *   id: "acme.client",
 *   bind(c) {
 *     clients.set(c.application, new Client())
 *   },
 * })
 *
 * const lookup: Enricher = { fetch: (ex) => clients.of(ex)?.get(ex.body) }
 * ```
 */
export function applicationState<T>(): ApplicationState<T> {
  const held = new WeakMap<ApplicationKey, T>();
  return {
    set: (application, value) => {
      held.set(application, value);
    },
    get: (application) =>
      application === undefined ? undefined : held.get(application),
    of: (exchange) => {
      const application = applicationOf(exchange);
      return application === undefined ? undefined : held.get(application);
    },
  };
}
