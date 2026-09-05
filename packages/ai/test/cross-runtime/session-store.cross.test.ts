import { afterAll, afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "../../src/agent/session/index.ts";

/**
 * Cross-runtime contract for the durable agent session store.
 *
 * The store has a genuine runtime-specific driver split (`bun:sqlite` under
 * Bun, `better-sqlite3` under Node, through core's shared resolver), and
 * the whole point of a session is that a conversation survives a restart.
 * So the properties that make durability real, a record that reads back
 * after a reopen and a compare-and-swap that produces exactly one winner,
 * are proven on both runtimes rather than on whichever one CI happens to
 * run first.
 *
 * The suite itself is runtime-agnostic: it opens a store and asserts on
 * behaviour, and the driver underneath is what differs. The
 * `adapter-cross-runtime` CI jobs run this file once per runtime.
 */

const scratch = mkdtempSync(join(tmpdir(), "rc-session-cross-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const key = { agent: "max", session: "feature-login" };

describe("agent session store (cross-runtime)", () => {
  let store: SqliteSessionStore | undefined;

  // Closing on the last line of each test leaks a handle whenever an
  // assertion fails first, and the afterAll rmSync then fails on top of the
  // real failure.
  afterEach(async () => {
    if (store) await store.close();
    store = undefined;
  });

  /**
   * @case The runtime resolves the driver its split prescribes
   * @preconditions A store opened on the current runtime
   * @expectedResult Bun reports bun:sqlite, Node reports better-sqlite3
   */
  test("resolves the driver for this runtime", async () => {
    store = await SqliteSessionStore.open({ path: ":memory:" });
    const expected =
      typeof process.versions["bun"] === "string"
        ? "bun:sqlite"
        : "better-sqlite3";
    expect(store.driver).toBe(expected);
  });

  /**
   * @case A conversation outlives the process that held it
   * @preconditions A record written to an on-disk database, then reopened
   * @expectedResult The record reads back unchanged, at the version it was written at
   */
  test("a record survives a close and reopen", async () => {
    const path = join(scratch, "reopen.db");
    const first = await SqliteSessionStore.open({ path });
    const record = {
      kind: "agent-session",
      messages: [{ role: "user", content: "hello" }],
      turns: 1,
    };
    expect(await first.create(key, record)).toEqual({ won: true });
    await first.close();

    store = await SqliteSessionStore.open({ path });
    const stored = await store.get(key);
    expect(stored?.version).toBe(1);
    expect(stored?.value).toEqual(record);
  });

  /**
   * @case Two writers at one version produce exactly one winner
   * @preconditions A stored record at version 1, replaced twice at that version
   * @expectedResult The first replace wins and bumps the version, the second loses and changes nothing
   */
  test("a compare-and-swap has exactly one winner", async () => {
    store = await SqliteSessionStore.open({ path: join(scratch, "cas.db") });
    await store.create(key, { turns: 0 });

    expect(await store.replace(key, 1, { turns: 1 })).toEqual({ won: true });
    expect(await store.replace(key, 1, { turns: 99 })).toEqual({ won: false });

    const stored = await store.get(key);
    expect(stored?.version).toBe(2);
    expect(stored?.value).toEqual({ turns: 1 });
  });

  /**
   * @case A second first-writer is told it lost rather than failing
   * @preconditions A key already created, then created again
   * @expectedResult The second create answers won: false and leaves the first record standing
   */
  test("a second create loses instead of throwing", async () => {
    store = await SqliteSessionStore.open({ path: join(scratch, "first.db") });
    expect(await store.create(key, { turns: 1 })).toEqual({ won: true });
    expect(await store.create(key, { turns: 2 })).toEqual({ won: false });
    expect((await store.get(key))?.value).toEqual({ turns: 1 });
  });

  /**
   * @case Enumeration is in code point order on both runtimes
   * @preconditions Three keys created out of order, one of them outside the Basic Multilingual Plane
   * @expectedResult keys() answers agent then session in code point order
   */
  test("keys enumerate in code point order", async () => {
    store = await SqliteSessionStore.open({ path: join(scratch, "keys.db") });
    await store.create({ agent: "max", session: "b" }, {});
    await store.create({ agent: "max", session: "\u{1f600}" }, {});
    await store.create({ agent: "ada", session: "a" }, {});
    await store.create({ agent: "max", session: "￿" }, {});

    expect(await store.keys()).toEqual([
      { agent: "ada", session: "a" },
      { agent: "max", session: "b" },
      { agent: "max", session: "￿" },
      { agent: "max", session: "\u{1f600}" },
    ]);
  });

  /**
   * @case A read after teardown is refused rather than answered
   * @preconditions A store closed while a caller still holds it
   * @expectedResult The read throws AI1012 naming the teardown
   */
  test("a call after close is refused", async () => {
    const closed = await SqliteSessionStore.open({ path: ":memory:" });
    await closed.close();
    await expect(closed.get(key)).rejects.toThrow(/closed/i);
  });
});
