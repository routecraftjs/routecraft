/**
 * Cosine similarity comparator for use with group(). Reads a vector field from
 * each item and returns true when similarity exceeds the threshold.
 */

export interface Comparator<T = unknown> {
  compare: (a: T, b: T) => boolean;
}

export interface CosineOptions {
  /** Field on each item that holds the embedding (number[]). */
  field: string;
  /** Similarity threshold (0–1). Items are grouped when similarity > threshold. Default: 0.82 */
  threshold?: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Creates a comparator that groups items by cosine similarity of a vector field.
 * Use with group(): group({ comparator: cosine({ field: 'embedding', threshold: 0.82 }) }).
 */
export function cosine<T = unknown>(options: CosineOptions): Comparator<T> {
  const { field, threshold = 0.82 } = options;
  return {
    compare(a: T, b: T): boolean {
      const va = (a as Record<string, unknown>)[field];
      const vb = (b as Record<string, unknown>)[field];
      if (!Array.isArray(va) || !Array.isArray(vb)) return false;
      return cosineSimilarity(va as number[], vb as number[]) > threshold;
    },
  };
}
