/**
 * Comparator for grouping: returns true when two items should be in the same group.
 * Used with `group({ comparator })`.
 *
 * @template T - Item type (e.g. object with an embedding field)
 */
export interface Comparator<T = unknown> {
  compare: (a: T, b: T) => boolean;
}

/**
 * Options for the cosine similarity comparator.
 */
export interface CosineOptions {
  /** Property on each item that holds the embedding vector (number[]). */
  field: string;
  /** Similarity threshold in 0-1. Items are grouped when similarity > threshold. Default: 0.82 */
  threshold?: number;
}
