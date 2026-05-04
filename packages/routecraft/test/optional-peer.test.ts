import { describe, expect, test } from "vitest";
import { loadOptionalPeer } from "../src/adapters/shared/optional-peer";
import { isRoutecraftError } from "../src/brand";

describe("loadOptionalPeer", () => {
  /**
   * @case Loader resolves successfully
   * @preconditions Loader returns the imported module
   * @expectedResult Returns the module unchanged
   */
  test("returns the module when the loader resolves", async () => {
    const fakeModule = { greet: () => "hi" };
    const mod = await loadOptionalPeer(async () => fakeModule, {
      adapterName: "fake",
      packageName: "fake-pkg",
    });
    expect(mod).toBe(fakeModule);
  });

  /**
   * @case Loader throws ERR_MODULE_NOT_FOUND
   * @preconditions Loader rejects with a missing-module error
   * @expectedResult Throws RC5017 with a message naming the adapter, the package, and the install command
   */
  test("throws RC5017 with install hint when the package is missing", async () => {
    const cause = Object.assign(new Error("Cannot find package 'fake-pkg'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });

    await expect(
      loadOptionalPeer(
        async () => {
          throw cause;
        },
        { adapterName: "fake", packageName: "fake-pkg" },
      ),
    ).rejects.toMatchObject({
      rc: "RC5017",
      message: expect.stringContaining(
        'fake adapter requires the optional peer dependency "fake-pkg"',
      ),
    });
  });

  /**
   * @case Error preserves cause and brand
   * @preconditions Loader rejects with an Error
   * @expectedResult Thrown error is a branded RoutecraftError carrying the original cause
   */
  test("wraps the original error as cause and is brand-detectable", async () => {
    const cause = new Error("npm install fake-pkg, then retry");
    let thrown: unknown;
    try {
      await loadOptionalPeer(
        async () => {
          throw cause;
        },
        { adapterName: "fake", packageName: "fake-pkg" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(isRoutecraftError(thrown)).toBe(true);
    expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });
});
