/* eslint-disable no-console -- Executable qualification of the ordering claim. */
import {
  application,
  infrastructure,
  port,
  allRuns,
} from "../../src/v2/index.ts";
const contract = port<true>("policy@1");
function provider(id: string, replacement = false) {
  return infrastructure({
    id,
    provides: [contract],
    replaces: replacement ? [contract] : [],
    bind(c) {
      c.provide(contract, true);
      c.contribute({
        kind: "wrapper",
        id: "policy",
        survival: allRuns,
        bind: () => (next, run) => next(run),
      });
    },
  });
}
const audit = infrastructure({
  id: "m.audit",
  bind: (c) =>
    c.contribute({
      kind: "wrapper",
      id: "audit",
      survival: allRuns,
      bind: () => (next, run) => next(run),
    }),
});
const first = application([provider("a.default"), audit]),
  second = application([provider("z.replacement", true), audit]);
await first.start([]);
await second.start([]);
console.log(
  "DEFAULT",
  first.runtime.dump().contributions.map((x) => x.id),
);
console.log(
  "REPLACEMENT",
  second.runtime.dump().contributions.map((x) => x.id),
);
await first.stop();
await second.stop();
