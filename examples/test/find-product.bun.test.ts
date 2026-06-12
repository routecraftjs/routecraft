import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import routes, { type Product } from "../src/find-product";

describe("Find Product Routes", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Dispatch a criteria into the reusable find-product route; it reads the
   *   catalogue from disk, casts it to Product[], and returns the matching item.
   * @preconditions find-product registered; context started; data/products.json on disk
   * @expectedResult client.sendDirect resolves to the single Product whose id matches
   */
  test("reads the catalogue from disk and returns the matching product", async () => {
    t = await testContext().routes(routes).build();
    await t.startAndWaitReady();

    const result = await t.client.sendDirect<{ id: string }, Product | null>(
      "find-product",
      { id: "GIZMO-C" },
    );

    expect(result).toEqual({
      id: "GIZMO-C",
      name: "Gizmo C",
      price: 3.0,
      inStock: true,
    });
  });

  /**
   * @case Dispatch a criteria whose id is absent from the catalogue.
   * @preconditions find-product registered; context started
   * @expectedResult The transform's `?? null` fallback yields null, not undefined
   */
  test("returns null when no product matches the id", async () => {
    t = await testContext().routes(routes).build();
    await t.startAndWaitReady();

    const result = await t.client.sendDirect<{ id: string }, Product | null>(
      "find-product",
      { id: "DOES-NOT-EXIST" },
    );

    expect(result).toBeNull();
  });
});
