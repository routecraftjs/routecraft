/**
 * Topological sort with a named cycle in the error.
 *
 * Used twice: once for plugins by `dependsOn`, once for wrappers by
 * `before`/`after`. One algorithm, because a dependency graph and an
 * ordering graph are the same problem stated differently.
 */
export interface GraphNode {
  readonly id: string;
  /** Ids this node must come after. */
  readonly after: readonly string[];
}

export class CycleError extends Error {
  constructor(readonly cycle: readonly string[]) {
    super(`Cycle: ${cycle.join(" -> ")}`);
    this.name = "CycleError";
  }
}

export class MissingNodeError extends Error {
  constructor(
    readonly needed: string,
    readonly neededBy: string,
  ) {
    super(`"${neededBy}" requires "${needed}", which is not installed`);
    this.name = "MissingNodeError";
  }
}

export function topoSort<N extends GraphNode>(
  nodes: readonly N[],
  options: { readonly requireAll: boolean },
): N[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sorted: N[] = [];
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  const visit = (node: N): void => {
    const seen = state.get(node.id);
    if (seen === "done") return;
    if (seen === "visiting") {
      const from = path.indexOf(node.id);
      throw new CycleError([...path.slice(from), node.id]);
    }
    state.set(node.id, "visiting");
    path.push(node.id);
    for (const dep of node.after) {
      const target = byId.get(dep);
      if (target === undefined) {
        if (options.requireAll) throw new MissingNodeError(dep, node.id);
        continue;
      }
      visit(target);
    }
    path.pop();
    state.set(node.id, "done");
    sorted.push(node);
  };

  for (const node of nodes) visit(node);
  return sorted;
}
