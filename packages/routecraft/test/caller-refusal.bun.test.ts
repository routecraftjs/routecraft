import { afterEach, describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  callerRefusalOf,
  craft,
  definePlugin,
  direct,
  isInputValidationFailure,
  defaultAuthority,
  noop,
  rcError,
  refuse,
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

  const principal = defaultAuthority.brand<Principal>({
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
   * @case An .input() schema that fails without reporting any issue
   * @preconditions Route "broken" whose body schema returns `{ issues: [] }`
   * @expectedResult RC5065 whose cause carries no input detail, so it is not classified as a caller refusal
   */
  test("does not classify an issueless schema failure as the caller's", async () => {
    const broken = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ issues: [] }),
      },
    } as unknown as StandardSchemaV1;
    t = await testContext()
      .routes(
        craft()
          .id("broken")
          .input({ body: broken })
          .from(simple({ id: "1" }))
          .to(noop()),
      )
      .build();
    await t.test();
    const error = t.errors.find((e) => e.rc === "RC5065");

    expect(error).toBeDefined();
    expect(isInputValidationFailure(error?.cause)).toBe(false);
    expect(
      callerRefusalOf(error, { routeId: "broken", principal: undefined }),
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

  /**
   * @case A validate hook refuses the dispatched route
   * @preconditions A plugin whose admitted validate hook refuses route "guarded" with kind "invalid" and a reason
   * @expectedResult A refused classification carrying the kind and the reason for "guarded"; undefined for any other route id, since a refusal raised by a nested route is that route's caller's doing
   */
  test("classifies a hook refusal by the route it was raised on", async () => {
    t = await testContext()
      .with({
        plugins: [
          definePlugin({
            id: "test.guard",
            hooks: {
              admitted: {
                id: "shape",
                phase: "validate",
                run: () => refuse("tenant header missing", { kind: "invalid" }),
              },
            },
          }),
        ],
      })
      .routes(craft().id("guarded").from(direct()).to(noop()))
      .build();
    await t.startAndWaitReady();
    const error = await t.client.sendDirect("guarded", {}).catch((e) => e);

    expect(
      callerRefusalOf(error, { routeId: "guarded", principal: undefined }),
    ).toEqual({
      kind: "refused",
      as: "invalid",
      reason: "tenant header missing",
    });
    expect(
      callerRefusalOf(error, { routeId: "outer", principal: undefined }),
    ).toBeUndefined();
  });

  /**
   * @case A hook refuses as unauthenticated on a door that reads no credential
   * @preconditions The same hook refusing with kind "unauthenticated"; one origin where a credential could help and one where it could not
   * @expectedResult The kind stands where a credential could help, and is answered as forbidden where the door never reads one
   */
  test("downgrades an unauthenticated refusal where no credential is read", async () => {
    t = await testContext()
      .with({
        plugins: [
          definePlugin({
            id: "test.guard",
            hooks: {
              admitted: {
                id: "who",
                phase: "validate",
                run: () => refuse("sign in first", { kind: "unauthenticated" }),
              },
            },
          }),
        ],
      })
      .routes(craft().id("guarded").from(direct()).to(noop()))
      .build();
    await t.startAndWaitReady();
    const error = await t.client.sendDirect("guarded", {}).catch((e) => e);

    expect(
      callerRefusalOf(error, {
        routeId: "guarded",
        principal: undefined,
        credentialCouldHelp: true,
      }),
    ).toMatchObject({ kind: "refused", as: "unauthenticated" });
    expect(
      callerRefusalOf(error, { routeId: "guarded", principal: undefined }),
    ).toMatchObject({ kind: "refused", as: "forbidden" });
  });

  /**
   * @case An RC5068 without the hook detail
   * @preconditions rcError("RC5068") thrown by hand, with no cause
   * @expectedResult Undefined: only a refusal the kernel raised for a hook on the dispatched route is the caller's
   */
  test("leaves a bare RC5068 the instance's", () => {
    expect(
      callerRefusalOf(rcError("RC5068"), {
        routeId: "guarded",
        principal: undefined,
      }),
    ).toBeUndefined();
  });

  /**
   * @case An RC5068 whose cause carries a well-formed hook detail built by hand
   * @preconditions rcError("RC5068", cause) where cause names the dispatched route, a hook, a slot, a kind and a reason, but was never raised by the kernel
   * @expectedResult Undefined: the detail's shape is public, and only a detail the kernel raised for a validate hook is the caller's
   */
  test("leaves a forged RC5068 the instance's", () => {
    const forged = Object.assign(new Error("tenant header missing"), {
      refused: {
        hook: "acme.tenancy/check",
        slot: "validate",
        routeId: "guarded",
        kind: "invalid",
        reason: "tenant header missing",
      },
    });
    expect(
      callerRefusalOf(rcError("RC5068", forged), {
        routeId: "guarded",
        principal: undefined,
      }),
    ).toBeUndefined();
  });

  /**
   * @case An RC5065 and an RC5049 whose cause carries a well-formed input detail built by hand
   * @preconditions rcError(code, cause) where cause names the dispatched route, a part and issues, but was raised by neither .input() nor the resume door
   * @expectedResult Undefined for both: a step cannot have its own failure answered as the caller's bad input by giving it the validator's shape
   */
  test("leaves a forged input failure the instance's", () => {
    const forge = () =>
      Object.assign(new Error("bad"), {
        invalid: {
          in: "body",
          issues: [{ message: "bad", path: ["id"] }],
          routeId: "typed",
        },
      });
    const origin = { routeId: "typed", principal: undefined };
    expect(callerRefusalOf(rcError("RC5065", forge()), origin)).toBeUndefined();
    expect(callerRefusalOf(rcError("RC5049", forge()), origin)).toBeUndefined();
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

  /**
   * @case A caller-chosen record key and a long custom message reach the wire
   * @preconditions 20 issues whose path starts with a 100 000-character key and whose message is 10 000 characters
   * @expectedResult Every path and message is clipped, so the refusal stays a few kilobytes however long the caller's keys are
   */
  test("clips each path and message", () => {
    const key = "k".repeat(100_000);
    const issues = Array.from({ length: 20 }, (_, i) => ({
      path: [key, i],
      message: "m".repeat(10_000),
    }));

    const result = wireIssues(issues);

    for (const issue of result.issues) {
      expect(Array.from(issue.path!).length).toBeLessThanOrEqual(256);
      expect(Array.from(issue.message).length).toBeLessThanOrEqual(256);
    }
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
  });

  /**
   * @case A text longer than the cap in UTF-16 units but not in characters
   * @preconditions One issue whose message is 200 emoji: 400 units, 200 code points
   * @expectedResult The message passes whole, since only code points count against the cap
   */
  test("keeps a text within the cap in characters", () => {
    const message = "\u{1F600}".repeat(200);

    expect(wireIssues([{ message }]).issues[0]!.message).toBe(message);
  });

  /**
   * @case A message of emoji longer than the cap, so the cut lands inside the run of astral characters
   * @preconditions One issue whose message is 300 emoji (each a surrogate pair in UTF-16)
   * @expectedResult The clipped message is whole emoji plus the ellipsis, with no lone surrogate
   */
  test("never splits a character when it clips", () => {
    const result = wireIssues([{ message: "\u{1F600}".repeat(300) }]);

    const message = result.issues[0]!.message;
    expect(message.endsWith("...")).toBe(true);
    expect(message.isWellFormed()).toBe(true);
    expect(Array.from(message)).toHaveLength(256);
  });
});
