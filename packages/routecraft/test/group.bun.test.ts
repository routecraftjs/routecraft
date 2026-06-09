import { describe, expect, test } from "bun:test";
import { group, cosine } from "../src/index.ts";
import type { Exchange } from "../src/index.ts";

// group()'s transformer derives everything from the body; the exchange
// argument of CallableTransformer is unused by the adapter, so a
// placeholder satisfies the two-argument signature for direct unit calls.
const noExchange = undefined as unknown as Exchange<unknown>;

type Item = { id: string; embedding: number[] };

describe("group()", () => {
  /**
   * @case group(comparator) clusters items by cosine similarity on embedding field
   * @preconditions Array of items with embedding vectors, cosine comparator threshold 0.9
   * @expectedResult Two groups: two similar items together, one orthogonal item alone
   */
  test("groups items by comparator (cosine)", () => {
    const items: Item[] = [
      { id: "a", embedding: [1, 0, 0, 0] },
      { id: "b", embedding: [1, 0, 0, 0] },
      { id: "c", embedding: [0, 1, 0, 0] },
    ];
    const adapter = group<Item>({
      comparator: cosine({ field: "embedding", threshold: 0.9 }),
    });
    const result = adapter.transform(items, noExchange) as Item[][];
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(2);
    expect(result[1]).toHaveLength(1);
    const ids = result.flatMap((g) => g.map((x) => x.id)).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  /**
   * @case group(comparator, { map }) applies map to each cluster
   * @preconditions Two similar items, map returns { count, first }
   * @expectedResult Single group with count 2 and first id "a"
   */
  test("map option shapes each cluster", () => {
    const items: Item[] = [
      { id: "a", embedding: [1, 0] },
      { id: "b", embedding: [1, 0] },
    ];
    const adapter = group<Item, { count: number; first: string }>({
      comparator: cosine({ field: "embedding", threshold: 0.9 }),
      map: (cluster) => ({ count: cluster.length, first: cluster[0].id }),
    });
    const result = adapter.transform(items, noExchange) as {
      count: number;
      first: string;
    }[];
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(2);
    expect(["a", "b"]).toContain(result[0].first);
  });

  /**
   * @case group(comparator, { from, to }) reads array from body and writes result back
   * @preconditions body.items is array, from plucks items, to merges groups into body
   * @expectedResult Result has groups array with one cluster of two items
   */
  test("from option reads array from body", () => {
    const body = {
      items: [
        { id: 1, v: [1, 0] },
        { id: 2, v: [1, 0] },
      ],
    };
    const adapter = group({
      comparator: cosine({ field: "v", threshold: 0.9 }),
      from: (b) => (b as { items: { id: number; v: number[] }[] }).items,
      to: (b, result) => ({ ...(b as object), groups: result }),
    });
    const result = adapter.transform(body, noExchange) as {
      items: unknown[];
      groups: unknown[];
    };
    expect(result.groups).toHaveLength(1);
    expect((result.groups[0] as { id: number }[]).length).toBe(2);
  });

  /**
   * @case group(comparator) with single item
   * @preconditions Array of one item with embedding
   * @expectedResult One group containing that item
   */
  test("single item yields one group", () => {
    const adapter = group({
      comparator: cosine({ field: "embedding", threshold: 0.82 }),
    });
    const result = adapter.transform(
      [{ id: "only", embedding: [1, 0, 0] }],
      noExchange,
    ) as { id: string; embedding: number[] }[][];
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].id).toBe("only");
  });
});
