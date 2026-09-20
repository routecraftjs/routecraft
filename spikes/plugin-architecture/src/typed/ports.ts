import { topoSort } from "../kernel/graph.ts";
declare const type: unique symbol;
/** Invariant payload, process-local identity. Publish and import the same value. */
export type Port<T> = {
  readonly key: symbol;
  readonly label: string;
  readonly [type]?: (value: T) => T;
};
export const port = <T>(label: string): Port<T> =>
  Object.freeze({ key: Symbol(label), label });
type Identity = { readonly key: symbol; readonly label: string };
export interface Plan {
  readonly id: string;
  readonly provides: readonly Identity[];
  readonly requires: readonly Identity[];
}
/** Contracts choose edges; implementation IDs are used only for diagnostics. */
export function orderPlans(plans: readonly Plan[]): readonly Plan[] {
  const owners = new Map<symbol, Plan>(),
    ids = new Set<string>();
  for (const p of plans) {
    if (ids.has(p.id)) throw Error(`Duplicate plugin ${p.id}`);
    ids.add(p.id);
    for (const t of p.provides) {
      if (owners.has(t.key)) throw Error(`Ambiguous provider ${t.label}`);
      owners.set(t.key, p);
    }
  }
  return topoSort(
    plans.map((p) => ({
      id: p.id,
      plan: p,
      after: p.requires.map((t) => {
        const owner = owners.get(t.key);
        if (!owner) throw Error(`${p.id} requires ${t.label}`);
        return owner.id;
      }),
    })),
    { requireAll: true },
  ).map((n) => n.plan);
}
