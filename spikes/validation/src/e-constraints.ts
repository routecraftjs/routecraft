/**
 * Awkward thing (e): an ordering constraint naming an absent plugin is
 * silently ignored, so a typo vanishes.
 *
 * The spike frames this as a binary: fatal (which makes every optional
 * dependency hard) or inert (which swallows typos). There is a third option,
 * and it costs one array and one accessor.
 *
 * Unmatched constraints stay inert, and core RECORDS them. The record is
 * readable at boot, so a typo is a line in the startup report and an
 * assertion in a test, not a silence. A nearest-neighbour suggestion closes
 * the last gap, because the failure mode that matters is not "id I invented"
 * but "id I misspelled" and "id that was renamed under me".
 */
export interface UnmatchedConstraint {
  readonly by: string;
  readonly names: string;
  readonly relation: "before" | "after";
  readonly suggestion?: string;
}

function distance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++)
    rows.push([i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i]![j] =
        a[i - 1] === b[j - 1]
          ? rows[i - 1]![j - 1]!
          : 1 +
            Math.min(rows[i - 1]![j]!, rows[i]![j - 1]!, rows[i - 1]![j - 1]!);
    }
  }
  return rows[a.length]![b.length]!;
}

export interface OrderedNode {
  readonly id: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

/**
 * Returns the unmatched constraints, with a suggestion when an installed id
 * is within edit distance 3. Inert ordering is unchanged; what changes is
 * that the silence is now a value.
 */
export function unmatchedConstraints(
  nodes: readonly OrderedNode[],
): readonly UnmatchedConstraint[] {
  const installed = new Set(nodes.map((n) => n.id));
  const out: UnmatchedConstraint[] = [];
  const check = (node: OrderedNode, relation: "before" | "after") => {
    for (const names of node[relation] ?? []) {
      if (installed.has(names)) continue;
      let suggestion: string | undefined;
      let best = 4;
      for (const candidate of installed) {
        const d = distance(names, candidate);
        if (d < best) {
          best = d;
          suggestion = candidate;
        }
      }
      out.push(
        suggestion === undefined
          ? { by: node.id, names, relation }
          : { by: node.id, names, relation, suggestion },
      );
    }
  };
  for (const node of nodes) {
    check(node, "before");
    check(node, "after");
  }
  return out;
}

export function report(unmatched: readonly UnmatchedConstraint[]): string {
  return unmatched
    .map(
      (u) =>
        `"${u.by}" declares ${u.relation} "${u.names}", which no installed plugin provides` +
        (u.suggestion === undefined ? "" : `. Did you mean "${u.suggestion}"?`),
    )
    .join("\n");
}
