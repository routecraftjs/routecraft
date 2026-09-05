import type { AgentSessionKey } from "./types.ts";
import type { SessionCasResult, SessionStore, StoredSession } from "./port.ts";

/**
 * In-process session store: the `"memory"` backend, and what tests use.
 * Everything it holds dies with the process, so a conversation kept here
 * does not survive a restart, which is the one promise sessions make;
 * the store factory warns whenever it falls back to this backend.
 *
 * Values round-trip through JSON on the way in and out, so a caller never
 * shares a reference with the store and the backend behaves like one that
 * actually persisted.
 */
export class MemorySessionStore implements SessionStore {
  readonly #records = new Map<string, StoredSession>();

  async get(key: AgentSessionKey): Promise<StoredSession | undefined> {
    const stored = this.#records.get(slot(key));
    return stored
      ? { value: clone(stored.value), version: stored.version }
      : undefined;
  }

  async create(
    key: AgentSessionKey,
    value: unknown,
  ): Promise<SessionCasResult> {
    const id = slot(key);
    if (this.#records.has(id)) return { won: false };
    this.#records.set(id, { value: clone(value), version: 1 });
    return { won: true };
  }

  async replace(
    key: AgentSessionKey,
    expectedVersion: number,
    value: unknown,
  ): Promise<SessionCasResult> {
    const id = slot(key);
    const current = this.#records.get(id);
    if (!current || current.version !== expectedVersion) return { won: false };
    this.#records.set(id, {
      value: clone(value),
      version: current.version + 1,
    });
    return { won: true };
  }

  async keys(): Promise<AgentSessionKey[]> {
    return [...this.#records.keys()]
      .map(unslot)
      .sort(
        (a, b) => compare(a.agent, b.agent) || compare(a.session, b.session),
      );
  }

  async close(): Promise<void> {
    // Nothing held open; the records stay until the store is collected, so
    // a second context in the same process reads what the first wrote.
  }
}

function slot(key: AgentSessionKey): string {
  return `${encodeURIComponent(key.agent)}:${encodeURIComponent(key.session)}`;
}

function unslot(id: string): AgentSessionKey {
  const at = id.indexOf(":");
  return {
    agent: decodeURIComponent(id.slice(0, at)),
    session: decodeURIComponent(id.slice(at + 1)),
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
