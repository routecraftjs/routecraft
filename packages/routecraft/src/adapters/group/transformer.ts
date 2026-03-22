import type { Transformer } from "../../operations/transform.ts";
import type { GroupOptions } from "./types.ts";

/**
 * GroupTransformerAdapter groups an array into clusters using a comparator.
 */
export class GroupTransformerAdapter<
  T = unknown,
  R = T[],
> implements Transformer<unknown, unknown> {
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
