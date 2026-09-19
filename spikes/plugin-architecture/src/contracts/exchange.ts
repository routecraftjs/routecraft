import type { Token } from "./token.ts";

/**
 * The unit of work. Core owns its identity and lifecycle and knows nothing
 * about what any plugin attaches to it.
 *
 * Plugin state lives behind {@link Exchange.use} rather than as a named
 * property, because a named property would require core to know the name.
 * See SPIKE-F1 in the README: this is an ergonomic regression from today's
 * `ex.deferral` and the spike records it rather than hiding it.
 */
export interface Exchange<Body = unknown> {
  readonly id: string;
  readonly routeId: string;
  body: Body;
  readonly headers: Record<string, unknown>;

  /** The extension a plugin registered under `token`, or undefined. */
  use<T>(token: Token<T>): T | undefined;
}

/** What core hands a plugin's exchange-extension factory. */
export interface ExchangeExtensionFactory<T> {
  readonly token: Token<T>;
  create(exchange: Exchange): T;
}
