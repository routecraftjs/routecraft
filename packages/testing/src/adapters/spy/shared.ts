import type { Exchange } from "@routecraft/routecraft";

/**
 * Internal state container for the spy adapter.
 */
export interface SpyState<T> {
  received: Exchange<T>[];
  calls: { send: number; process: number; enrich: number };
}

/**
 * Creates fresh spy state with empty received array and zeroed counters.
 */
export function createSpyState<T>(): SpyState<T> {
  return {
    received: [],
    calls: { send: 0, process: 0, enrich: 0 },
  };
}
