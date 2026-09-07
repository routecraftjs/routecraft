import type { MemorySuspensionStore } from "@routecraft/routecraft";
import { MemorySessionStore } from "../../src/agent/session/index.ts";
import {
  emptyAgentSession,
  type AgentSessionStore,
} from "../../src/agent/session/store.ts";
import type { AgentSessionRecord } from "../../src/agent/session/types.ts";

/**
 * Write to a session record from a test, seeding one that does not exist
 * yet with `agent`. The runtime has its own seam for this, which also
 * refuses a dispatch naming the wrong persona; a test reaching the store
 * directly is deliberately below that rule.
 */
export function updateRecord(
  sessions: AgentSessionStore,
  key: string,
  agent: string,
  mutate: (record: AgentSessionRecord) => AgentSessionRecord,
): Promise<AgentSessionRecord> {
  return sessions.update(key, (record) =>
    mutate(record ?? emptyAgentSession(key, agent)),
  );
}

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
