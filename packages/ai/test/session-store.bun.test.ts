import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySessionStore,
  SqliteSessionStore,
  type SessionStore,
} from "../src/agent/session/index.ts";

const scratch = mkdtempSync(join(tmpdir(), "rc-sessions-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const key = { agent: "max", session: "feature-login" };

/**
 * The shared contract suite. Every backend must satisfy it identically:
 * that is what makes the sqlite default and the in-memory backend
 * interchangeable, and what a backend written outside this repo is held to.
 */
function contractSuite(name: string, open: () => Promise<SessionStore>): void {
  describe(`SessionStore contract: ${name}`, () => {
    let store: SessionStore | undefined;

    afterEach(async () => {
      if (store) await store.close();
      store = undefined;
    });

    /**
     * @case A key never written reads back as undefined and lists nothing
     * @preconditions A fresh store
     * @expectedResult get() answers undefined and keys() is empty
     */
    test("an unknown key is undefined", async () => {
      store = await open();
      expect(await store.get(key)).toBeUndefined();
      expect(await store.keys()).toEqual([]);
    });

    /**
     * @case A first write lands at version 1 and reads back by value, not by reference
     * @preconditions A fresh store; a record is created and the object handed in is then mutated
     * @expectedResult get() answers the record as written with version 1, unaffected by the later mutation, and a mutation of what get() returned does not reach the store either
     */
    test("create writes version 1 and clones both ways", async () => {
      store = await open();
      const value = { kind: "agent-session", turns: 1, inbox: [] as string[] };
      expect(await store.create(key, value)).toEqual({ won: true });
      value.inbox.push("mutated after the write");
      const stored = await store.get(key);
      expect(stored).toEqual({
        value: { kind: "agent-session", turns: 1, inbox: [] },
        version: 1,
      });
      (stored!.value as { inbox: string[] }).inbox.push(
        "mutated after the read",
      );
      expect((await store.get(key))!.value).toEqual({
        kind: "agent-session",
        turns: 1,
        inbox: [],
      });
    });

    /**
     * @case Two first writers for one key are told apart
     * @preconditions A record exists for the key
     * @expectedResult A second create() loses and leaves the first record in place
     */
    test("a second create loses", async () => {
      store = await open();
      await store.create(key, { turns: 1 });
      expect(await store.create(key, { turns: 99 })).toEqual({ won: false });
      expect((await store.get(key))!.value).toEqual({ turns: 1 });
    });

    /**
     * @case A replace lands only against the version it read, and bumps it
     * @preconditions A record at version 1; one writer replaces at version 1, a second writer still holds version 1
     * @expectedResult The first replace wins and the record is at version 2 with the new value; the second replace loses and changes nothing; a replace against a key never written loses
     */
    test("replace is a compare-and-swap on the version", async () => {
      store = await open();
      await store.create(key, { turns: 1 });
      expect(await store.replace(key, 1, { turns: 2 })).toEqual({ won: true });
      expect(await store.get(key)).toEqual({ value: { turns: 2 }, version: 2 });
      expect(await store.replace(key, 1, { turns: 3 })).toEqual({ won: false });
      expect(await store.get(key)).toEqual({ value: { turns: 2 }, version: 2 });
      expect(
        await store.replace({ agent: "max", session: "never" }, 1, {}),
      ).toEqual({ won: false });
    });

    /**
     * @case Keys enumerate in agent then session order, in code point order, and round-trip every character a session id or agent name may carry
     * @preconditions Records for five keys written out of order: one carrying a colon, a percent sign and non-ASCII letters, one agent named with a character outside the Basic Multilingual Plane (U+1F600) and one inside its upper range (U+FB01), which UTF-16 code-unit comparison orders the other way round
     * @expectedResult keys() answers the keys sorted by agent then session with U+FB01 before U+1F600, each character intact
     */
    test("keys are ordered by code point and round-trip", async () => {
      store = await open();
      const odd = { agent: "zoë", session: "ticket:42%done" };
      const astral = { agent: "\u{1F600}", session: "s" };
      const upperBmp = { agent: "\uFB01", session: "s" };
      await store.create({ agent: "max", session: "b" }, {});
      await store.create(astral, {});
      await store.create(odd, {});
      await store.create(upperBmp, {});
      await store.create({ agent: "max", session: "a" }, {});
      expect(await store.keys()).toEqual([
        { agent: "max", session: "a" },
        { agent: "max", session: "b" },
        odd,
        upperBmp,
        astral,
      ]);
      expect(await store.get(odd)).toEqual({ value: {}, version: 1 });
      expect(await store.get(astral)).toEqual({ value: {}, version: 1 });
    });

    /**
     * @case Closing twice is harmless
     * @preconditions An open store
     * @expectedResult The second close() resolves
     */
    test("close is idempotent", async () => {
      store = await open();
      await store.close();
      await store.close();
      store = undefined;
    });
  });
}

contractSuite("memory", async () => new MemorySessionStore());
contractSuite("sqlite (private in-process database)", () =>
  SqliteSessionStore.open({ path: ":memory:" }),
);

describe("SqliteSessionStore", () => {
  /**
   * @case A record survives closing and reopening the file
   * @preconditions A store at a file path writes one record and closes; a second store opens the same path
   * @expectedResult The second store reads the record at the version the first wrote, and its driver is the runtime's
   */
  test("a record outlives the store that wrote it", async () => {
    const path = join(scratch, "sessions.db");
    const first = await SqliteSessionStore.open({ path });
    await first.create(key, { turns: 1 });
    await first.replace(key, 1, { turns: 2 });
    await first.close();
    const second = await SqliteSessionStore.open({ path });
    expect(await second.get(key)).toEqual({ value: { turns: 2 }, version: 2 });
    expect(second.driver).toBe("bun:sqlite");
    await second.close();
  });

  /**
   * @case A store refuses work after it was closed, naming the operation
   * @preconditions A store opened on a private database and closed
   * @expectedResult get() rejects with AI1012 and a message naming a read after teardown
   */
  test("a closed store answers AI1012", async () => {
    const store = await SqliteSessionStore.open({ path: ":memory:" });
    await store.close();
    await expect(store.get(key)).rejects.toMatchObject({
      rc: "AI1012",
      message: expect.stringContaining("read arrived after teardown"),
    });
  });

  /**
   * @case A path that cannot hold a database is refused as AI1012, not as a raw driver error
   * @preconditions The parent of the requested path is a regular file
   * @expectedResult open() rejects with AI1012 naming the path
   */
  test("an unopenable path is AI1012", async () => {
    const blocker = join(scratch, "not-a-directory");
    writeFileSync(blocker, "a file where a directory is needed");
    await expect(
      SqliteSessionStore.open({ path: join(blocker, "sessions.db") }),
    ).rejects.toMatchObject({
      rc: "AI1012",
      message: expect.stringContaining("could not be opened"),
    });
  });
});
