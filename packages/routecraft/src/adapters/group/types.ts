import type { Comparator } from "../cosine/index.ts";

export interface GroupOptions<T = unknown, R = unknown> {
  comparator: Comparator<T>;
  /** Read the array to group from the body. Default: body is the array. */
  from?: (body: unknown) => T[];
  /** Shape each cluster into the output. Default: returns the raw cluster (T[]). */
  map?: (group: T[]) => R;
  /** Write the grouped result back. Default: replaces the entire body. */
  to?: (body: unknown, result: R[]) => unknown;
}
