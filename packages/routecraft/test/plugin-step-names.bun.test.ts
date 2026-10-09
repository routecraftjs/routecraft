import { describe, expect, test } from "bun:test";
import {
  definePlugin,
  defineProject,
  rcCodeOf,
  step,
  type Body,
} from "../src/index.ts";

describe("plugin step names", () => {
  /**
   * @case A plugin declares a step named then, and another one named toJSON
   * @preconditions Each in its own project
   * @expectedResult RC1116 at defineProject: a builder with a then() is a thenable that never settles under await, and toJSON is read by JSON.stringify
   */
  test("the names the language reads off every object are refused", () => {
    for (const name of ["then", "toJSON"]) {
      const plugin = definePlugin({
        id: "test.protocol",
        steps: { [name]: () => step<Body, Body>((ex) => ex.body) },
      });
      let refused: unknown;
      try {
        defineProject({ plugins: [plugin] }).craft();
      } catch (error) {
        refused = error;
      }
      expect([name, rcCodeOf(refused)]).toEqual([name, "RC1116"]);
    }
  });
});
