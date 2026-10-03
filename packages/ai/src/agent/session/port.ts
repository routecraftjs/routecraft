import { port } from "@routecraft/routecraft";
import type { AgentSessionKey } from "./types.ts";

/**
 * What a session store holds for one key: the record as plain JSON and
 * the version it was written at. The version is the compare half of the
 * compare-and-swap; a backend increments it on every successful write.
 */
export interface StoredSession {
  readonly value: unknown;
  readonly version: number;
}

/** Whether a compare-and-swap write landed. Exactly one concurrent writer wins. */
export interface SessionCasResult {
  readonly won: boolean;
}

/**
 * Where agent session records live: one durable slot per session id, with
 * a compare-and-swap on write, on whichever backend the deployment
 * configured through `sessions: { store }`.
 *
 * The contract is the smallest thing the runtime needs, so a backend of
 * your own is a few dozen lines: two writes that either land or report the
 * lost race, one read, one enumeration.
 *
 * `keys()` is the enumeration fallback and nothing more. Filtering by
 * owner, agent or working directory, paging, and every authorization
 * decision happen in the runtime above this interface, which re-checks
 * ownership on each record whatever a store returns. A store is never the
 * authorization boundary, so a naive one is slow rather than leaky. An
 * optional filtered listing may be added here for backends that can serve
 * one; a store implementing only what is below keeps working.
 *
 * Values are plain JSON and a backend may round-trip them through
 * serialisation, so a caller never sees the reference it wrote. The
 * shipped backends are {@link MemorySessionStore} and
 * {@link SqliteSessionStore}, and both run the same contract-test suite.
 *
 * The deferred continuation a session stores between turns is not here: it
 * is a deferred exchange and lives in the deferral store with every other
 * one.
 */
export interface SessionStore {
  /** The stored record for `key`, or `undefined` for a session never written. */
  get(key: AgentSessionKey): Promise<StoredSession | undefined>;
  /**
   * Write the first record for `key` at version 1. Loses (`won: false`)
   * when a record already exists, which is how two first writers are told
   * apart without a read-then-write race.
   */
  create(key: AgentSessionKey, value: unknown): Promise<SessionCasResult>;
  /**
   * Replace the record when the stored version is still `expectedVersion`,
   * bumping the version. Loses when another writer landed in between, or
   * when no record exists.
   */
  replace(
    key: AgentSessionKey,
    expectedVersion: number,
    value: unknown,
  ): Promise<SessionCasResult>;
  /**
   * Every key the store holds, in code point order (what SQLite's binary
   * collation gives UTF-8 text), so every backend enumerates identically.
   */
  keys(): Promise<AgentSessionKey[]>;
  /**
   * Forget the session entirely: the record and every version of it.
   *
   * A key the store does not hold is not an error, so deleting twice and
   * deleting a conversation that never existed both succeed. There is no
   * compare-and-swap here because there is nothing to compare against
   * afterwards, which is why a caller deletes what it has decided is
   * finished rather than what it read a moment ago.
   */
  remove(key: AgentSessionKey): Promise<void>;
  /** Release what the store holds open. Idempotent. */
  close(): Promise<void>;
}

/** Something writing to a session store that must stop before it closes. */
export interface SessionWriter {
  stop(): Promise<void>;
}

/**
 * The store an application resolved, with what it resolved to for the log
 * line and whether the application owns its lifecycle.
 */
export interface ResolvedSessionStore {
  readonly store: SessionStore;
  /**
   * `custom` is a store the caller supplied; reporting it as `sqlite` would
   * mislead exactly the operator who configured a backend deliberately.
   * `unresolved` is the lazy form before anything touched it, which is the
   * one state where the answer is not yet known.
   */
  readonly backend: "sqlite" | "memory" | "custom" | "unresolved";
  /** Which sqlite driver opened it, where one did. */
  readonly driver?: string;
  /**
   * False when the caller supplied the store, in which case they own its
   * lifecycle and teardown must not close it.
   */
  readonly ownsStore: boolean;
  /** Whether a `sessions` block chose this store rather than the default. */
  readonly configured: boolean;
  /**
   * Hold the store open for a session runtime. {@link close} stops every
   * retained writer before it releases the store: a revival still in
   * flight must not write to a closed one.
   */
  retain(writer: SessionWriter): void;
  /** Stop the retained writers, then close the store if it is owned. Idempotent. */
  close(): Promise<void>;
}

/**
 * Where an application's agent sessions live. Provided by the sessions
 * plugin: the `sessions` key, or the default the agent runtime brings
 * along. Adapters reach it with `context.lookup(SESSION_STORE)`.
 */
export const SESSION_STORE = port<ResolvedSessionStore>(
  "routecraft.ai.session-store@1",
);
