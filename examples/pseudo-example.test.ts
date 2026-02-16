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
    const steps = definitions[0].steps;

    expect(definitions).toHaveLength(1);
    expect(definitions[0].id).toBe("pseudo-example");
    expect(steps).toHaveLength(3);
    expect(steps[0].operation).toBe("enrich");
    expect(steps[1].operation).toBe("split");
    expect(steps[2].operation).toBe("tap");
  });
});
