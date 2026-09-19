import type { Contribution, ExchangeContribution } from "../contracts/index.ts";
import { DEFERRAL_EXT } from "../plugins/deferral.ts";
declare function erased(c: Contribution): void;
declare function correlated<T>(c: ExchangeContribution<T>): void;
function checks() {
  erased({
    kind: "exchange",
    id: "bad-context",
    factory: {
      token: DEFERRAL_EXT,
      create: () => ({
        // @ts-expect-error unknown return context cannot infer the nested affordance callback argument
        defer: (reason) => Promise.resolve(reason),
      }),
    },
  });
  correlated({
    kind: "exchange",
    id: "good-context",
    factory: {
      token: DEFERRAL_EXT,
      create: () => ({ defer: (reason) => Promise.resolve(reason) }),
    },
  });
  // An overload is not universally necessary: a separately checked descriptor also works.
  const descriptor: ExchangeContribution<{
    defer(reason: string): Promise<string>;
  }> = {
    kind: "exchange",
    id: "descriptor",
    factory: {
      token: DEFERRAL_EXT,
      create: () => ({ defer: (reason) => Promise.resolve(reason) }),
    },
  };
  erased(descriptor);
}
void checks;
