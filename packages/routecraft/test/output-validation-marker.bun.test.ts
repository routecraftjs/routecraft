import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import { DefaultExchange, wasOutputValidated } from "../src/index.ts";
import {
  applyOutputValidation,
  type ValidationDeps,
} from "../src/pipeline/validation.ts";

/**
 * The marker output validation leaves on an exchange, read at request/reply
 * adapter boundaries (the MCP server is the first) to tell a body the route
 * vouched for from one that arrived another way.
 */
describe("output validation marker", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /** Minimal deps: the success path reads none of them. */
  const depsFor = (ctx: TestContext["ctx"]): ValidationDeps =>
    ({
      routeId: "marker-test",
      context: ctx,
      route: {},
      buildForward: () => () => Promise.resolve(undefined),
    }) as unknown as ValidationDeps;

  /**
   * @case Validation records the schema it accepted the body against
   * @preconditions Exchange validated against one schema; a second, structurally identical schema is used to probe
   * @expectedResult The validating schema reads as validated and the other does not, so an exchange vouched for by one contract cannot walk past a different one unexamined
   */
  test("records which schema accepted the body", async () => {
    t = await testContext().build();
    const schema = z.object({ value: z.string() });
    const other = z.object({ value: z.string() });

    const validated = await applyOutputValidation(
      depsFor(t.ctx),
      new DefaultExchange(t.ctx, { body: { value: "hi" } }),
      { body: schema },
    );

    expect(wasOutputValidated(validated, schema)).toBe(true);
    expect(wasOutputValidated(validated, other)).toBe(false);
  });

  /**
   * @case An unvalidated exchange carries no marker
   * @preconditions Exchange built directly, never passed through output validation
   * @expectedResult wasOutputValidated is false, so a boundary enforcing the schema knows it still has to
   */
  test("leaves an unvalidated exchange unmarked", async () => {
    t = await testContext().build();
    const schema = z.object({ value: z.string() });

    const exchange = new DefaultExchange(t.ctx, { body: { value: "hi" } });

    expect(wasOutputValidated(exchange, schema)).toBe(false);
  });

  /**
   * @case The marker survives the rewrap that carries the validated value
   * @preconditions Output schema applies a default, so validation replaces the body and returns a rewrapped exchange
   * @expectedResult The returned exchange carries both the transformed body and the marker, since the flag lives on the internals shared across rewraps
   */
  test("survives the rewrap carrying the validated value", async () => {
    t = await testContext().build();
    const schema = z.object({
      value: z.string(),
      seen: z.number().default(1),
    });

    const validated = await applyOutputValidation(
      depsFor(t.ctx),
      new DefaultExchange(t.ctx, { body: { value: "hi" } }),
      { body: schema },
    );

    expect(validated.body).toEqual({ value: "hi", seen: 1 });
    expect(wasOutputValidated(validated, schema)).toBe(true);
  });
});
