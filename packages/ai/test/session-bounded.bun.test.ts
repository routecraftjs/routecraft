import { describe, expect, test } from "bun:test";
import { BoundedMap, BoundedSet } from "../src/agent/session/bounded.ts";

/**
 * The per-process memory the session runtime keeps about sessions: bounded,
 * young entries kept over old ones, and a pinned entry kept over any.
 */

describe("bounded session memory", () => {
  /**
   * @case A set past its bound forgets its oldest member, and a re-added member is young again
   * @preconditions A set bounded at 2; a, b added, a re-added, then c
   * @expectedResult b is forgotten and a and c remain
   */
  test("a set forgets the oldest", () => {
    const set = new BoundedSet<string>(2);
    set.add("a");
    set.add("b");
    set.add("a");
    set.add("c");
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(false);
    expect(set.has("c")).toBe(true);
  });

  /**
   * @case A read refreshes an entry whatever its value, a pinned entry survives evictions until unpinned, and pins never count against the bound
   * @preconditions A map bounded at 2 holding a (value undefined) and b; a is read, then c is set; a is pinned and d, e are set; a is unpinned; then in a fresh map bounded at 2, a and b are pinned and c is set
   * @expectedResult After c: b is gone and a stays (the read refreshed it despite its undefined value). While a is pinned it is out of the count, so two more sets keep a and forget c. The unpin trims a. With every slot pinned, a new entry still lands and stays
   */
  test("a map refreshes on read and keeps a pinned entry", () => {
    const map = new BoundedMap<string, number | undefined>(2);
    map.set("a", undefined);
    map.set("b", 1);
    map.get("a");
    map.set("c", 2);
    expect(map.get("b")).toBeUndefined();
    expect(map.get("c")).toBe(2);
    map.pin("a");
    map.set("d", 3);
    map.set("e", 4);
    // Pinning keeps a through two more inserts and out of the count, so
    // c is the one forgotten and d, e both fit.
    expect(map.has("a")).toBe(true);
    expect(map.has("c")).toBe(false);
    expect(map.get("d")).toBe(3);
    expect(map.get("e")).toBe(4);
    map.unpin("a");
    expect(map.has("a")).toBe(false);
    expect(map.has("d")).toBe(true);

    const full = new BoundedMap<string, number>(2);
    full.set("a", 1);
    full.set("b", 2);
    full.pin("a");
    full.pin("b");
    full.set("c", 3);
    expect(full.get("c")).toBe(3);
    expect(full.get("a")).toBe(1);
    expect(full.get("b")).toBe(2);
  });
});
