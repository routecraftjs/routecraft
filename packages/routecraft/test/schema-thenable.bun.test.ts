import { afterEach, describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  spy,
  testContext,
  thenableSchema,
  type TestContext,
} from "@routecraft/testing";
import {
  craft,
  simple,
  DefaultExchange,
  wasOutputValidated,
} from "../src/index.ts";
import { schema as schemaValidator } from "../src/operations/validate.ts";
import {
  applyOutputValidation,
  validateAgainst,
  type ValidationDeps,
} from "../src/pipeline/validation.ts";

/**
 * Every validation boundary in core, held to the thenable contract rather
 * than the `Promise` class (see `validateAgainst` for what the contract is
 * and what awaiting one costs), plus the real-`Promise` case the old
 * `instanceof` check was there for.
 */
describe("schema returning a thenable", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  const rejecting = () =>
    thenableSchema<number>({
      issues: [{ message: "expected number" }],
    }) as StandardSchemaV1;

  /** Minimal deps: neither the success nor the throwing path reads them. */
  const depsFor = (ctx: TestContext["ctx"]): ValidationDeps =>
    ({
      routeId: "thenable-test",
      context: ctx,
      route: {},
      buildForward: () => () => Promise.resolve(undefined),
    }) as unknown as ValidationDeps;

  /**
   * @case validateAgainst reports the failure a thenable resolves to
   * @preconditions Schema whose validate() returns a non-Promise thenable resolving to issues
   * @expectedResult ok is false and the issues are carried through, rather than the input coming back marked ok
   */
  test("validateAgainst rejects what the thenable rejects", async () => {
    const result = await validateAgainst(rejecting(), "not a number");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("expected number");
    expect(result.issues).toHaveLength(1);
  });

  /**
   * @case validateAgainst takes the value a thenable accepts with
   * @preconditions Schema whose validate() returns a non-Promise thenable resolving to a transformed value
   * @expectedResult The transformed value is returned, so awaiting the thenable feeds the success path too
   */
  test("validateAgainst takes the thenable's transformed value", async () => {
    const result = await validateAgainst(thenableSchema({ value: 42 }), "42");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toBe(42);
  });

  /**
   * @case A real async schema still validates
   * @preconditions Schema whose validate() returns an actual Promise resolving to issues
   * @expectedResult The failure is reported, so widening the check to any thenable did not cost the Promise case
   */
  test("a real async schema still validates", async () => {
    const asyncSchema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => ({ issues: [{ message: "async reject" }] }),
      },
    };

    const result = await validateAgainst(asyncSchema, "anything");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("async reject");
  });

  /**
   * @case Route .input() rejects a body a thenable schema refused
   * @preconditions Route declares .input({ body }) with a rejecting thenable schema
   * @expectedResult RC5002 fails the exchange and the destination never runs, so the boundary control the caller asked for actually ran
   */
  test("route .input() rejects it", async () => {
    const downstream = spy();

    t = await testContext()
      .routes(
        craft()
          .id("thenable-input")
          .input({ body: rejecting() })
          .from(simple("not a number"))
          .to(downstream),
      )
      .build();

    await t.test();

    expect(t.errors.map((e) => e.rc)).toContain("RC5002");
    expect(downstream.received).toHaveLength(0);
  });

  /**
   * @case Route .input() rejects headers a thenable schema refused
   * @preconditions Route declares .input({ headers }) with a rejecting thenable schema
   * @expectedResult RC5002 fails the exchange and the destination never runs, so the headers arm of the bundle is enforced too, not only the body
   */
  test("route .input() rejects it on the headers schema too", async () => {
    const downstream = spy();

    t = await testContext()
      .routes(
        craft()
          .id("thenable-input-headers")
          .input({ headers: rejecting() })
          .from(simple("body is fine"))
          .to(downstream),
      )
      .build();

    await t.test();

    expect(t.errors.map((e) => e.rc)).toContain("RC5002");
    expect(downstream.received).toHaveLength(0);
  });

  /**
   * @case Route .output() rejects a body a thenable schema refused
   * @preconditions Route declares .output({ body }) with a rejecting thenable schema
   * @expectedResult The exchange fails instead of completing, so an invalid body cannot leave the route
   */
  test("route .output() rejects it", async () => {
    let failed = 0;
    let completed = 0;

    t = await testContext()
      .routes(
        craft()
          .id("thenable-output")
          .output({ body: rejecting() })
          .from(simple("not a number"))
          .to(spy()),
      )
      .on("route:exchange:failed", (() => {
        failed += 1;
      }) as never)
      .on("route:exchange:completed", (() => {
        completed += 1;
      }) as never)
      .build();

    await t.ctx.start();
    await t.drain();

    expect(failed).toBe(1);
    expect(completed).toBe(0);
  });

  /**
   * @case Output validation leaves no marker when a thenable schema refuses
   * @preconditions applyOutputValidation runs against a rejecting thenable schema
   * @expectedResult It throws and the exchange does not read as validated, so a downstream boundary still knows it has to check
   */
  test("output validation does not mark a refused exchange", async () => {
    t = await testContext().build();
    const output = rejecting();
    const exchange = new DefaultExchange(t.ctx, { body: "not a number" });

    await expect(
      applyOutputValidation(depsFor(t.ctx), exchange, { body: output }),
    ).rejects.toThrow();
    expect(wasOutputValidated(exchange, output)).toBe(false);
  });

  /**
   * @case The schema() validator throws on a thenable rejection
   * @preconditions schema() built from a rejecting thenable schema, run against a body
   * @expectedResult RC5002 with the schema's message, rather than the body passing through
   */
  test("schema() throws on it", async () => {
    t = await testContext().build();
    const validator = schemaValidator(rejecting());
    const exchange = new DefaultExchange(t.ctx, { body: "not a number" });

    await expect(validator.validate(exchange)).rejects.toThrow(
      /expected number/,
    );
  });
});
