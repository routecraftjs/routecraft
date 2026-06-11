import { describe, expect, test } from "bun:test";
import {
  RC,
  rcError,
  registerErrorCodes,
  isRoutecraftError,
} from "../src/index.ts";
import { getRegisteredErrorCodes } from "../src/error.ts";

describe("error-code registry", () => {
  /**
   * @case Every registered code matches NAMESPACE + 4 digits and has docs
   * @preconditions Core codes seeded; any ecosystem codes registered by imports
   * @expectedResult All codes match /^[A-Z][A-Z0-9]{1,7}\d{4}$/, are unique
   *   by Map construction, and carry a docs link under routecraft.dev
   */
  test("all registered codes are well-formed with docs links", () => {
    const codes = getRegisteredErrorCodes();
    expect(codes.size).toBeGreaterThanOrEqual(Object.keys(RC).length);
    for (const [code, meta] of codes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9]{1,7}\d{4}$/);
      expect(meta.docs).toStartWith(
        "https://routecraft.dev/docs/reference/errors",
      );
      expect(typeof meta.retryable).toBe("boolean");
    }
  });

  /**
   * @case registerErrorCodes rejects the reserved RC namespace
   * @preconditions Core has claimed RC for @routecraft/routecraft
   * @expectedResult RC1003 error mentioning the reservation
   */
  test("rejects the reserved RC namespace", () => {
    expect(() =>
      registerErrorCodes("RC", { RC8888: RC.RC9901 }, "some-package"),
    ).toThrow(/reserved/);
  });

  /**
   * @case registerErrorCodes rejects invalid namespace shapes
   * @preconditions Namespace pattern is ^[A-Z][A-Z0-9]{1,7}$
   * @expectedResult Lowercase, too-long, and digit-leading namespaces throw RC1003
   */
  test("rejects malformed namespaces", () => {
    expect(() => registerErrorCodes("ai", {}, "p")).toThrow(/invalid/);
    expect(() => registerErrorCodes("TOOLONGNS9", {}, "p")).toThrow(/invalid/);
    expect(() => registerErrorCodes("9AI", {}, "p")).toThrow(/invalid/);
  });

  /**
   * @case A namespace can only be claimed by one owner package
   * @preconditions TESTNS claimed by package-a
   * @expectedResult A claim by package-b throws RC1003 naming both packages;
   *   re-registration by package-a is idempotent and allowed
   */
  test("namespace collision names both owner packages", () => {
    const meta = {
      ...RC.RC9901,
      docs: "https://routecraft.dev/docs/reference/errors#testns-0001",
    };
    registerErrorCodes("TESTNS", { TESTNS0001: meta }, "package-a");
    expect(() =>
      registerErrorCodes("TESTNS", { TESTNS0002: meta }, "package-b"),
    ).toThrow(/package-a.*package-b/s);
    // same owner re-registers without error (module re-evaluation safety)
    registerErrorCodes("TESTNS", { TESTNS0001: meta }, "package-a");
  });

  /**
   * @case Codes must be the namespace followed by exactly four digits
   * @preconditions Valid namespace BADCODE claimed with a malformed key
   * @expectedResult RC1003 naming the offending code
   */
  test("rejects codes that do not match their namespace", () => {
    const meta = RC.RC9901;
    expect(() => registerErrorCodes("GOODNS", { GOODNS01: meta }, "p")).toThrow(
      /four digits/,
    );
    expect(() =>
      registerErrorCodes("GOODNS", { OTHER1234: meta }, "p"),
    ).toThrow(/four digits/);
  });

  /**
   * @case rcError resolves registered ecosystem codes at runtime
   * @preconditions DEMO namespace registered with DEMO1234
   * @expectedResult rcError("DEMO1234") returns a branded RoutecraftError
   *   with the registered metadata
   */
  test("rcError works for registered ecosystem codes", () => {
    registerErrorCodes(
      "DEMO",
      {
        DEMO1234: {
          category: "Adapter",
          message: "Demo failure",
          docs: "https://routecraft.dev/docs/reference/errors#demo-1234",
          retryable: true,
        },
      },
      "demo-package",
    );
    // Cast: DEMO1234 is registered at runtime above but not declaration-merged
    // into ErrorCodeRegistry (this test deliberately exercises the runtime path).
    const err = rcError("DEMO1234" as never);
    expect(isRoutecraftError(err)).toBe(true);
    expect(err.rc).toBe("DEMO1234" as never);
    expect(err.retryable).toBe(true);
  });

  /**
   * @case rcError throws a descriptive error for unknown codes
   * @preconditions No registration for the code
   * @expectedResult RC9901-coded error suggesting a missing package import
   */
  test("unknown codes produce a descriptive RC9901", () => {
    expect(() => rcError("ZZ9999" as never)).toThrow(/import the package/);
  });

  /**
   * @case rcError overrides can flip the retryable flag per occurrence
   * @preconditions RC5002 is retryable: false in core metadata; RC5010 is retryable: true
   * @expectedResult The override value wins on the constructed error while base metadata stays untouched
   */
  test("rcError accepts a retryable override", () => {
    const transientValidation = rcError("RC5002", undefined, {
      retryable: true,
    });
    expect(transientValidation.retryable).toBe(true);

    const permanentConnection = rcError("RC5010", undefined, {
      retryable: false,
    });
    expect(permanentConnection.retryable).toBe(false);

    // Base metadata is untouched by per-occurrence overrides.
    expect(rcError("RC5002").retryable).toBe(false);
    expect(rcError("RC5010").retryable).toBe(true);
  });
});
