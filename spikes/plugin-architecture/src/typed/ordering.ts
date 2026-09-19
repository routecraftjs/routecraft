const identity: unique symbol = Symbol("anchor");
export interface Anchor {
  readonly [identity]: symbol;
  readonly owner: string;
  readonly name: string;
}
export const anchor = (owner: string, name: string): Anchor => ({
  [identity]: Symbol(name),
  owner,
  name,
});
export type Constraint = {
  readonly target: Anchor;
  readonly presence: "required" | "ifPresent";
};
/** Optional means absent owner is allowed; installed owner with a missing
 * promised anchor is an error. References are imports, not handwritten ids.
 */
export function resolveEdges(
  installedOwners: ReadonlySet<string>,
  contributed: ReadonlySet<Anchor>,
  edges: readonly Constraint[],
): Anchor[] {
  return edges.flatMap(({ target, presence }) => {
    if (contributed.has(target)) return [target];
    if (presence === "ifPresent" && !installedOwners.has(target.owner))
      return [];
    throw Error(`Missing ordering anchor ${target.owner}/${target.name}`);
  });
}
