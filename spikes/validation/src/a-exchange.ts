/**
 * Awkward thing (a): `ex.deferral` becoming `ex.use(DEFERRAL_EXT)`.
 *
 * The spike's premise is "core cannot type a property whose name it does not
 * know". That is true only if the exchange type is fixed. It is not: the
 * exchange a route author touches is reached through the builder, and the
 * builder already carries a type parameter per installed plugin set for the
 * body. Carrying a second one for the extensions costs nothing new and gives
 * back `ex.deferral` as a real, checked property.
 *
 * The result is strictly better than today, not merely equal: today
 * `ex.deferral` exists on the type whether or not deferral is installed.
 * Here, declining the plugin removes the property from the type.
 */
import type { Step } from "../../plugin-architecture/src/contracts/index.ts";

/** Core's exchange, open at the extension slot and closed everywhere else. */
export interface Exchange<Body, Ext = Record<never, never>> {
  /** Phantom: the extension set this exchange was built under. */
  readonly __ext?: Ext;
  readonly id: string;
  readonly routeId: string;
  body: Body;
  readonly headers: Record<string, unknown>;
}

export type Enriched<Body, Ext> = Exchange<Body, Ext> & Ext;

/** A plugin declares its exchange extension as an ordinary named member. */
export interface ExchangePlugin {
  readonly id: string;
  /** Runtime: builds the value attached under each key. */
  readonly extensions?: Readonly<
    Record<string, (exchange: Exchange<unknown>) => unknown>
  >;
}

export type ExtOf<Plugins extends readonly ExchangePlugin[]> =
  Plugins extends readonly [infer Head, ...infer Tail]
    ? Head extends { readonly extensions: infer E }
      ? Tail extends readonly ExchangePlugin[]
        ? {
            [K in keyof E]: E[K] extends (ex: never) => infer R ? R : never;
          } & ExtOf<Tail>
        : { [K in keyof E]: E[K] extends (ex: never) => infer R ? R : never }
      : Tail extends readonly ExchangePlugin[]
        ? ExtOf<Tail>
        : Record<never, never>
    : Record<never, never>;

// --- what the deferral plugin ships --------------------------------------

export interface DeferralAffordance {
  defer(reason: string): Promise<string>;
  readonly deferred: boolean;
}

export const deferralPlugin = {
  id: "routecraft.deferral",
  extensions: {
    deferral: (exchange: Exchange<unknown>): DeferralAffordance => ({
      defer: (reason) => Promise.resolve(`def-${exchange.id}-${reason.length}`),
      deferred: false,
    }),
  },
} as const satisfies ExchangePlugin;

export const tracingPlugin = {
  id: "acme.tracing",
  extensions: {
    trace: (exchange: Exchange<unknown>) => ({
      spanId: exchange.id,
      mark: (name: string): void => void name,
    }),
  },
} as const satisfies ExchangePlugin;

export const bare = {
  id: "routecraft.operations",
} as const satisfies ExchangePlugin;

/** A step written by a route author, against the enriched exchange. */
export type Tap<Body, Ext> = (exchange: Enriched<Body, Ext>) => void;

export function tapStep<Body, Ext>(fn: Tap<Body, Ext>): Step {
  return { label: "tap", run: (ex) => fn(ex as never) };
}
