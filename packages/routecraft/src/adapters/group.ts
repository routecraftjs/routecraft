import { type Transformer } from "../operations/transform.ts";
import type { Comparator } from "./cosine.ts";

export interface GroupOptions<T = unknown, R = unknown> {
  comparator: Comparator<T>;
  /** Read the array to group from the body. Default: body is the array. */
  from?: (body: unknown) => T[];
  /** Shape each cluster into the output. Default: returns the raw cluster (T[]). */
  map?: (group: T[]) => R;
  /** Write the grouped result back. Default: replaces the entire body. */
  to?: (body: unknown, result: R[]) => unknown;
}

export class GroupAdapter<T = unknown, R = T[]> implements Transformer<
  unknown,
  unknown
> {
  readonly adapterId = "routecraft.adapter.group";

  constructor(private readonly options: GroupOptions<T, R>) {}

  transform(body: unknown): unknown {
    const items = this.options.from ? this.options.from(body) : (body as T[]);
    const clusters: T[][] = [];

    for (const item of items) {
      const match = clusters.find((c) =>
        c.some((member) => this.options.comparator.compare(member, item)),
      );
      if (match) {
        match.push(item);
      } else {
        clusters.push([item]);
      }
    }

    const result = this.options.map
      ? clusters.map(this.options.map)
      : (clusters as unknown as R[]);
    if (this.options.to) {
      return this.options.to(body, result as R[]);
    }
    return result;
  }
}

/**
 * Creates a transformer that groups an array into clusters using a comparator (e.g. cosine similarity).
 * By default uses body as the array and replaces the body with the array of clusters. Use `from`/`to` to read/write sub-fields; use `map` to shape each cluster.
 *
 * @param options - `comparator` (e.g. from `cosine()`), optional `from(body)`, `map(cluster)`, `to(body, result)`
 * @returns A Transformer usable with `.transform(group(options))`
 *
 * @example
 * ```typescript
 * .transform(group({
 *   comparator: cosine({ field: 'embedding', threshold: 0.82 }),
 *   from: (body) => body.items,
 *   map: (cluster) => ({ size: cluster.length, first: cluster[0] })
 * }))
 * ```
 */
export function group<T = unknown, R = T[]>(
  options: GroupOptions<T, R>,
): Transformer<unknown, unknown> {
  return new GroupAdapter<T, R>(options);
}
