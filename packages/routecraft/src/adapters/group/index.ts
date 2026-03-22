import type { Transformer } from "../../operations/transform.ts";
import type { GroupOptions } from "./types.ts";
import { GroupTransformerAdapter } from "./transformer.ts";

/**
 * Creates a transformer that groups an array into clusters using a comparator (e.g. cosine similarity).
 * By default uses body as the array and replaces the body with the array of clusters. Use `from`/`to` to read/write sub-fields; use `map` to shape each cluster.
 *
 * @beta
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
  return new GroupTransformerAdapter<T, R>(options);
}

// Re-export types
export type { GroupOptions } from "./types.ts";
