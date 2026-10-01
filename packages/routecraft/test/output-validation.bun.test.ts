import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  isInputValidationFailure,
  isOutputValidationFailure,
  noop,
  simple,
} from "../src/index.ts";

/**
 * The structured detail on the RC5002 a route's `.output()` raises, which
 * lets a door tell a broken declared contract from every other RC5002.
 */
describe("OutputValidationFailure", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  /**
   * @case .output() rejects the body and the headers a route produced
   * @preconditions Route "priced" whose .output({ body }) rejects its result; route "tagged" whose .output({ headers }) rejects its headers
   * @expectedResult Each RC5002 on route:exchange:failed has a cause that passes isOutputValidationFailure with the part, the issues and the route id, and neither passes isInputValidationFailure
   */
  test("names the part, the issues and the route", async () => {
    const causes: unknown[] = [];
    t = await testContext()
      .on("route:exchange:failed", ({ details }) => {
        causes.push((details.error as Error).cause);
      })
      .routes([
        craft()
          .id("priced")
          .output({ body: z.object({ total: z.number() }) })
          .from(simple({ total: "lots" }))
          .to(noop()),
        craft()
          .id("tagged")
          .output({ headers: z.object({ tenant: z.string() }) })
          .from(simple("ok"))
          .to(noop()),
      ])
      .build();
    await t.test();

    const details = causes
      .filter(isOutputValidationFailure)
      .map((cause) => ({
        in: cause.invalidOutput.in,
        routeId: cause.invalidOutput.routeId,
        path: cause.invalidOutput.issues[0]?.path,
      }))
      .sort((a, b) => a.routeId.localeCompare(b.routeId));
    expect(details).toEqual([
      { in: "body", routeId: "priced", path: ["total"] },
      { in: "headers", routeId: "tagged", path: ["tenant"] },
    ]);
    expect(causes.some(isInputValidationFailure)).toBe(false);
  });

  /**
   * @case A mid-pipeline .schema() step fails with the same code
   * @preconditions Route whose mid-pipeline .schema() step rejects its body
   * @expectedResult An RC5002 whose cause does not pass isOutputValidationFailure, so a door cannot mistake it for the declared output contract
   */
  test("is absent from a mid-pipeline schema failure", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("checked")
          .from(simple({ total: "lots" }))
          .schema(z.object({ total: z.number() }))
          .to(noop()),
      )
      .build();
    await t.test();

    const failure = t.errors.find((error) => error.rc === "RC5002");
    expect(failure).toBeDefined();
    expect(isOutputValidationFailure(failure!.cause)).toBe(false);
  });
});
