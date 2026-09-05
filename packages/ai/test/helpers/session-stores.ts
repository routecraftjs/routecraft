import type { MemorySuspensionStore } from "@routecraft/routecraft";
import { MemorySessionStore } from "../../src/agent/session/index.ts";

/**
 * The session store paired with a suspension store, so a "restart" built
 * over the same suspension store sees the same sessions, as one deployment
 * reopening both files would.
 */
const recordStores = new WeakMap<MemorySuspensionStore, MemorySessionStore>();

export function recordsFor(store: MemorySuspensionStore): MemorySessionStore {
  let records = recordStores.get(store);
  if (!records) {
    records = new MemorySessionStore();
    recordStores.set(store, records);
  }
  return records;
}
