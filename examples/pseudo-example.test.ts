import { describe, it, expect } from "vitest";
import route from "./pseudo-example.ts";

describe("Pseudo example route", () => {
  /**
   * @case Route using pseudo mcp enrich and split builds valid definition
   * @preconditions pseudo-example route imported
   * @expectedResult One route with three steps (enrich, split, tap)
   */
  it("builds a valid route definition with enrich, split, and tap steps", () => {
    const definitions = route.build();

    expect(definitions).toHaveLength(1);
    expect(definitions[0].id).toBe("pseudo-example");
    expect(definitions[0].steps).toHaveLength(3); // enrich, split, tap
  });
});
