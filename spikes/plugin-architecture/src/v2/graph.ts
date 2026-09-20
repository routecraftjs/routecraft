import { Fault } from "./contracts.ts";
/** One deterministic topological sort for installation and contribution ordering. */
export function sort<T extends { id: string; after: readonly string[] }>(
  nodes: readonly T[],
): T[] {
  const byId = new Map<string, T>();
  for (const n of nodes) {
    if (byId.has(n.id)) throw new Fault(n.id, "DUPLICATE_ID", n.id);
    byId.set(n.id, n);
  }
  for (const n of nodes)
    for (const dep of n.after)
      if (!byId.has(dep)) throw new Fault(n.id, "MISSING_DEPENDENCY", dep);
  const done = new Set<string>(),
    result: T[] = [];
  while (result.length < nodes.length) {
    const next = nodes
      .filter((n) => !done.has(n.id) && n.after.every((d) => done.has(d)))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    if (!next)
      throw new Fault(
        nodes
          .filter((n) => !done.has(n.id))
          .map((n) => n.id)
          .sort()
          .join(", "),
        "CYCLE",
        nodes
          .filter((n) => !done.has(n.id))
          .map((n) => `${n.id} <- ${n.after.join(",")}`)
          .join("; "),
      );
    done.add(next.id);
    result.push(next);
  }
  return result;
}
