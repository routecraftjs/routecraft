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
   * @case A read refreshes an entry whatever its value, and a pinned entry survives evictions until unpinned
   * @preconditions A map bounded at 2 holding a (value undefined) and b; a is read, then c is set; then a is pinned and d, e are set; then a is unpinned and f is set
   * @expectedResult After c: b is gone and a stays (the read refreshed it despite its undefined value). While pinned, a outlives d and e. Once unpinned, the next set forgets it
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
    expect(map.get("e")).toBe(4);
    map.unpin("a");
    map.set("f", 5);
    map.set("g", 6);
    expect(map.get("f")).toBe(5);
    expect(map.get("g")).toBe(6);
  });
});
