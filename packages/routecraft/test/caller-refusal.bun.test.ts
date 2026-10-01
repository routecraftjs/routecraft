import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  callerRefusalOf,
  craft,
  markAuthentic,
  noop,
  rcError,
  simple,
  wireIssues,
  type Principal,
  type Source,
} from "../src/index.ts";

/** Emit one body carrying `principal`, the way an authenticating door does. */
function principalSource<T>(body: T, principal?: Principal): Source<T> {
  return {
    subscribe: async (sub) => {
      await sub.emit({
        message: body,
        ...(principal
          ? { headers: { "routecraft.auth.principal": principal } }
          : {}),
      });
    },
  };
}

/**
 * The door-agnostic classification behind every door's answer to a route
 * failure: which failures the caller caused, and what it can do about them.
 */
describe("callerRefusalOf()", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  const principal = markAuthentic<Principal>({
    kind: "custom",
    scheme: "bearer",
    subject: "user-1",
    scopes: ["orders:read"],
  });

  /**
   * @case An .input() refusal on the dispatched route
   * @preconditions Route "typed" whose .input() rejects the body it receives
   * @expectedResult An input refusal with the part and each issue's path and message for "typed"; undefined for any other route id
   */
  test("classifies an input refusal by the route that raised it", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("typed")
          .input({ body: z.object({ id: z.string() }) })
          .from(simple({ id: 123 }))
          .to(noop()),
      )
      .build();
    await t.test();
    const error = t.errors[0];

    expect(
      callerRefusalOf(error, { routeId: "typed", principal: undefined }),
    ).toMatchObject({ kind: "input", in: "body", omitted: 0 });
    expect(
      callerRefusalOf(error, { routeId: "typed", principal: undefined }),
    ).toHaveProperty(["issues", 0, "path"], "id");
    expect(
      callerRefusalOf(error, { routeId: "other", principal: undefined }),
    ).toBeUndefined();
  });

  /**
   * @case An RC5065 thrown by a step rather than by .input()
   * @preconditions A bare rcError("RC5065") with no InputValidationFailure cause
   * @expectedResult undefined: the code alone does not make the failure the caller's
   */
  test("does not classify an input code without its detail", () => {
    expect(
      callerRefusalOf(rcError("RC5065"), {
        routeId: "r",
        principal: undefined,
      }),
    ).toBeUndefined();
  });

  /**
   * @case authorize() finds no principal
   * @preconditions Route "guarded" with .authorize() entered with no principal
   * @expectedResult undefined unless the door says a credential could have helped, then unauthenticated
   */
  test("classifies a missing principal only where a credential could help", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("guarded")
          .authorize()
          .from(principalSource("hello"))
          .to(noop()),
      )
      .build();
    await t.test();
    const error = t.errors.find((e) => e.rc === "RC5012");

    expect(
      callerRefusalOf(error, { routeId: "guarded", principal: undefined }),
    ).toBeUndefined();
    expect(
      callerRefusalOf(error, {
        routeId: "guarded",
        principal: undefined,
        credentialCouldHelp: true,
      }),
    ).toEqual({ kind: "unauthenticated" });
  });

  /**
   * @case authorize() refuses for lacking any scope of an accepted set
   * @preconditions Route "writer" with .authorize({ anyScope: ["orders:write", "orders:admin"] }) entered with a principal carrying orders:read
   * @expectedResult insufficient_scope with anyOf and the whole accepted set for that principal; undefined for an equal-looking copy of it
   */
  test("classifies a scope refusal of the admitted principal", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("writer")
          .authorize({ anyScope: ["orders:write", "orders:admin"] })
          .from(principalSource("hello", principal))
          .to(noop()),
      )
      .build();
    await t.test();
    const error = t.errors.find((e) => e.rc === "RC5038");

    expect(callerRefusalOf(error, { routeId: "writer", principal })).toEqual({
      kind: "insufficient_scope",
      scopes: ["orders:write", "orders:admin"],
      anyOf: true,
    });
    expect(
      callerRefusalOf(error, {
        routeId: "writer",
        principal: { ...principal },
      }),
    ).toBeUndefined();
  });

  /**
   * @case A step throws an authorization code itself
   * @preconditions rcError("RC5015") not raised by authorize()
   * @expectedResult undefined, as an adapter's upstream login refusal must stay the instance's
   */
  test("does not classify an authorization code authorize() did not raise", () => {
    expect(
      callerRefusalOf(rcError("RC5015"), { routeId: "r", principal }),
    ).toBeUndefined();
  });
});

describe("wireIssues()", () => {
  /**
   * @case More issues than the wire carries, one with a non-string message
   * @preconditions 23 issues with array paths; the first carries a non-string message
   * @expectedResult 20 issues with dot-joined paths, the non-string message read as "invalid", and 3 counted as omitted
   */
  test("caps the issues and counts the rest", () => {
    const issues = Array.from({ length: 23 }, (_, i) => ({
      path: ["items", i],
      message: i === 0 ? (42 as unknown as string) : "Expected number",
    }));

    const result = wireIssues(issues);

    expect(result.issues).toHaveLength(20);
    expect(result.issues[0]).toEqual({ path: "items.0", message: "invalid" });
    expect(result.issues[1]).toEqual({
      path: "items.1",
      message: "Expected number",
    });
    expect(result.omitted).toBe(3);
  });
});
