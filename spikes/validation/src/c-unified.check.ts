import { token } from "../../plugin-architecture/src/contracts/index.ts";
import type { Step } from "../../plugin-architecture/src/contracts/index.ts";
import {
  definePlugin,
  type StepsOfUnified,
  type UnifiedBuilder,
} from "./c-unified.ts";

type Expect<T extends true> = T;

interface StoreApi {
  open(ns: string): { put(k: string, v: unknown): Promise<void> };
}
const STORE_API = token<StoreApi>("routecraft.stores.api");

interface DeferralApi {
  defer(reason: string): Promise<string>;
}
const DEFERRAL_API = token<DeferralApi>("routecraft.deferral.api");

/**
 * Deferral, declared end to end. Every point is data. There is no `apply`,
 * no `ctx.contribute`, and the wrapper still closes over the API built from
 * the resolved store, which is the thing that forced the imperative call.
 */
export const deferral = definePlugin({
  id: "routecraft.deferral",
  needs: { store: STORE_API },
  provides: DEFERRAL_API,

  setup: ({ store }) => {
    const ns = store.open("deferral");
    let seq = 0;
    return {
      defer: async (reason: string) => {
        const id = `def-${++seq}`;
        await ns.put(id, { reason });
        return id;
      },
    } satisfies DeferralApi;
  },

  steps: (api) => ({
    defer: (reason: string): Step => ({
      label: "defer",
      run: async (ex) =>
        void (ex.headers["deferred"] = await api.defer(reason)),
    }),
  }),

  wrappers: (api) => ({
    "routecraft.admission": {
      after: ["routecraft.authorize"],
      before: ["routecraft.retry"],
      wrap: (next) => async (ex) => {
        if (ex.headers["needs-approval"] === true) {
          await api.defer("admission");
          return;
        }
        await next(ex);
      },
    },
  }),

  handlers: (api) => ({
    "routecraft.deferral.recovery": {
      point: "error",
      handle: async () => void (await api.defer("error-recovery")),
    },
  }),

  exchange: (api) => ({
    deferral: () => ({ defer: (reason: string) => api.defer(reason) }),
  }),

  health: (api) => ({ up: api !== undefined }),
});

/** `setup`'s return type flows into every thunk with no annotation. */
export type SelfIsInferred = Expect<
  Parameters<NonNullable<typeof deferral.steps>>[0] extends DeferralApi
    ? true
    : false
>;

/** And the builder still derives through the thunk. */
declare const b: UnifiedBuilder<StepsOfUnified<readonly [typeof deferral]>>;
export const chained = b.defer("needs approval").build();
// @ts-expect-error `defer` takes a string reason.
b.defer(42);
// @ts-expect-error nothing declares `transform` in this plugin set.
b.transform((x: unknown) => x);
