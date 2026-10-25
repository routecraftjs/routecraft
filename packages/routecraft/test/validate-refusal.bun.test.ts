import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  callerRefusalOf,
  craft,
  direct,
  isHookRefusal,
  noop,
  otherwise,
  refuse,
  when,
} from "../src/index.ts";
import { anonymousOrigin as origin } from "./helpers/authority.ts";
import { expectBodyOf } from "./helpers/types.ts";

/**
 * A route that refuses its caller after the door: the rule needs state the
 * input schema cannot see (a page that already exists, a model's verdict),
 * so it runs as a `.validate()` step mid-pipeline, and the caller is told
 * why, the way an `.input()` or a validate-hook refusal tells it.
 */
describe(".validate() refusing the caller", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  /**
   * @case A validator that throws a plain Error
   * @preconditions Route "capture" whose .validate() throws for a body it rejects
   * @expectedResult The failure is the instance's: callerRefusalOf answers undefined, so an unexpected throw never reaches a caller as a reason
   */
  test("leaves a plain throw the instance's", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("capture")
          .from(direct<{ title?: string }>())
          .validate((exchange) => {
            if (exchange.body.title === undefined) throw new Error("no title");
            return exchange.body;
          })
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    const error = await t.client.sendDirect("capture", {}).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(callerRefusalOf(error, origin("capture"))).toBeUndefined();
  });

  /**
   * @case A validator that returns refuse()
   * @preconditions Route "capture" whose .validate() answers refuse(reason, { kind: "conflict" }) for a body it rejects, and a later step that reads the validated body's title
   * @expectedResult The run fails with RC5068 whose cause names the step and the route, callerRefusalOf classifies it for "capture" with the kind and the reason exactly as a validate hook's refusal, and undefined for any other route id; the refusal never reaches the next step as the body, and the body type after .validate() excludes the refusal
   */
  test("tells the caller why when the validator returns a refusal", async () => {
    const seen: string[] = [];
    t = await testContext()
      .routes(
        craft()
          .id("capture")
          .from(direct<{ title?: string }>())
          .validate((exchange) =>
            exchange.body.title === "Weekly sync"
              ? refuse("A meeting page titled Weekly sync already exists.", {
                  kind: "conflict",
                })
              : exchange.body,
          )
          .transform((body) => {
            seen.push(body.title ?? "");
            return body;
          })
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    const error = await t.client
      .sendDirect("capture", { title: "Weekly sync" })
      .then(() => undefined)
      .catch((e) => e);

    expect(error).toBeDefined();
    expect(error.rc).toBe("RC5068");
    expect(isHookRefusal(error.cause)).toBe(true);
    expect(error.cause.refused).toMatchObject({
      origin: "step",
      hook: "validate",
      slot: "pipeline",
      routeId: "capture",
      kind: "conflict",
    });
    expect(callerRefusalOf(error, origin("capture"))).toEqual({
      kind: "refused",
      as: "conflict",
      reason: "A meeting page titled Weekly sync already exists.",
    });
    expect(callerRefusalOf(error, origin("outer"))).toBeUndefined();
    expect(seen).toEqual([]);

    await t.client.sendDirect("capture", { title: "Retro" });
    expect(seen).toEqual(["Retro"]);
  });

  /**
   * @case A validator that throws refuse()
   * @preconditions Route "capture" whose .validate() throws refuse(reason) with no kind for a body it rejects
   * @expectedResult The thrown refusal is raised and classified exactly as a returned one, with the default kind forbidden
   */
  test("tells the caller why when the validator throws a refusal", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("capture")
          .from(direct<{ title?: string }>())
          .validate((exchange) => {
            if (exchange.body.title === undefined) {
              throw refuse("A title is required for a page.");
            }
            return exchange.body;
          })
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    const error = (await t.client
      .sendDirect("capture", {})
      .catch((e) => e)) as { rc?: string };

    expect(error.rc).toBe("RC5068");
    expect(callerRefusalOf(error, origin("capture"))).toEqual({
      kind: "refused",
      as: "forbidden",
      reason: "A title is required for a page.",
    });
  });

  /**
   * @case A refusal raised by a nested direct() call
   * @preconditions Route "outer" forwards to route "capture" with .to(direct("capture")), and capture's .validate() refuses
   * @expectedResult The refusal is bound to "capture", so a door that dispatched "outer" answers its caller with the code alone: callerRefusalOf is undefined for "outer" and classifies for "capture"
   */
  test("keeps a nested route's refusal the instance's at the outer door", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("outer")
          .from(direct<{ title?: string }>())
          .to(direct("capture")),
        craft()
          .id("capture")
          .from(direct<{ title?: string }>())
          .validate(() => refuse("Already exists.", { kind: "conflict" }))
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();
    const error = (await t.client
      .sendDirect("outer", { title: "Weekly sync" })
      .catch((e) => e)) as { rc?: string };

    expect(error.rc).toBe("RC5068");
    expect(callerRefusalOf(error, origin("outer"))).toBeUndefined();
    expect(callerRefusalOf(error, origin("capture"))?.kind).toBe("refused");
  });

  /**
   * @case The body type after a validator that may refuse
   * @preconditions A validator returning the body or refuse(), and one returning refuse() alone
   * @expectedResult The route's body type after .validate() is the validator's body type with no Refusal in it, and a validator that only refuses leaves the body type as it was
   */
  test("keeps the refusal out of the body type", () => {
    const either = craft()
      .id("either")
      .from(direct<{ title?: string }>())
      .validate((exchange) =>
        exchange.body.title === undefined
          ? refuse("A title is required for a page.")
          : exchange.body,
      );
    expectBodyOf(either).toEqualTypeOf<{ title?: string }>();

    const always = craft()
      .id("always")
      .from(direct<{ title?: string }>())
      .validate(() => refuse("Never."));
    expectBodyOf(always).toEqualTypeOf<{ title?: string }>();
  });

  /**
   * @case The body type after a validator that never returns
   * @preconditions A validator typed never (it always throws), on its own, in its async form, and as the last step of a .choice<T>() branch whose other branch produces T; an async validator returning a narrowed body or a refusal
   * @expectedResult The body after .validate() is never, since the validator has no continuation, so the branch fits any T and the route compiles; the async forms type the same as the sync ones; the refusal-only case above is unaffected
   */
  test("types the body after a validator that never returns as never", () => {
    const fail = (): never => {
      throw new Error("Not created.");
    };

    const failing = craft()
      .id("failing")
      .from(direct<{ title?: string }>())
      .validate(fail);
    expectBodyOf(failing).toEqualTypeOf<never>();

    const failingAsync = craft()
      .id("failing-async")
      .from(direct<{ title?: string }>())
      .validate(async (): Promise<never> => fail());
    expectBodyOf(failingAsync).toEqualTypeOf<never>();

    const eitherAsync = craft()
      .id("either-async")
      .from(direct<{ title?: string }>())
      .validate(async (exchange) =>
        exchange.body.title === undefined
          ? refuse("A title is required for a page.")
          : { title: exchange.body.title },
      );
    expectBodyOf(eitherAsync).toEqualTypeOf<{ title: string }>();

    const branched = craft()
      .id("branched")
      .from(direct<{ title?: string }>())
      .choice<{ created: true }>(
        when(
          (exchange) => exchange.body.title === undefined,
          (failed) => failed.transform(() => ({ mailed: true })).validate(fail),
        ),
        otherwise((created) => created.transform(() => ({
          created: true as const,
        }))),
      );
    expectBodyOf(branched).toEqualTypeOf<{ created: true }>();
  });

  /**
   * @case A route answers its own validator's refusal in .error()
   * @preconditions Route "capture" with .error() recovering an RC5068 into a body, and a .validate() that refuses
   * @expectedResult The refusal reaches the route's error handler like any failure, and the handler's recovery body is the run's result
   */
  test("reaches the route's own error handler like any failure", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("capture")
          .from(direct<{ title?: string }>())
          .error((err) => ({ recovered: (err as { rc?: string }).rc }))
          .validate(() => refuse("Already exists.", { kind: "conflict" }))
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    const result = await t.client.sendDirect("capture", { title: "x" });

    expect(result).toEqual({ recovered: "RC5068" });
  });
});
