import {
  bare,
  deferralPlugin,
  type Enriched,
  type ExtOf,
  tracingPlugin,
} from "./a-exchange.ts";

type Expect<T extends true> = T;

type Installed = readonly [
  typeof bare,
  typeof deferralPlugin,
  typeof tracingPlugin,
];
type Ex = Enriched<{ subject: string }, ExtOf<Installed>>;

declare const ex: Ex;

/** `ex.deferral` is back, by name, and fully typed. */
export const id: Promise<string> = ex.deferral.defer("needs approval");
export const flag: boolean = ex.deferral.deferred;
export const span: string = ex.trace.spanId;
export const body: string = ex.body.subject;

// @ts-expect-error the affordance is typed; `defer` takes a string.
ex.deferral.defer(42);

// @ts-expect-error nothing contributes `cache`, so the property does not exist.
ex.cache.get("k");

/** Declining the plugin removes the property, which today's `ex.deferral` cannot do. */
type WithoutDeferral = Enriched<
  { subject: string },
  ExtOf<readonly [typeof bare, typeof tracingPlugin]>
>;
declare const lean: WithoutDeferral;
export const stillTraces: string = lean.trace.spanId;
// @ts-expect-error deferral is declined, so `ex.deferral` is not on the type.
lean.deferral.defer("nope");

export type ExtensionsAreNamed = Expect<
  "deferral" extends keyof Ex ? true : false
>;
