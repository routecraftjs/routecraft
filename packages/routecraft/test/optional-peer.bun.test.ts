import { describe, expect, test } from "bun:test";
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
      consumer: "fake adapter",
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
        { consumer: "fake adapter", packageName: "fake-pkg" },
      ),
    ).rejects.toMatchObject({
      rc: "RC5017",
      message: expect.stringContaining(
        'fake adapter requires the optional peer dependency "fake-pkg"',
      ),
    });
  });

  /**
   * @case A longer package sharing the requested package's prefix is quoted earlier in the same message
   * @preconditions Loader rejects with ERR_MODULE_NOT_FOUND whose message quotes `@scope/pkg-extra` before `@scope/pkg`
   * @expectedResult Still throws RC5017. Only the first occurrence used to be examined, so the boundary check failed against `-extra` and the real, later occurrence was never reached, degrading the install hint into a raw ERR_MODULE_NOT_FOUND
   */
  test("matches a later occurrence when an earlier one shares the prefix", async () => {
    const cause = Object.assign(
      new Error(
        "Cannot find package '@scope/pkg-extra' imported from /app/a.js. " +
          "Cannot find package '@scope/pkg' imported from /app/b.js",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );

    await expect(
      loadOptionalPeer(
        async () => {
          throw cause;
        },
        { consumer: "fake adapter", packageName: "@scope/pkg" },
      ),
    ).rejects.toMatchObject({ rc: "RC5017" });
  });

  /**
   * @case Only a longer package sharing the prefix is missing
   * @preconditions Loader rejects with ERR_MODULE_NOT_FOUND naming `@scope/pkg-extra` and never the requested `@scope/pkg`
   * @expectedResult Rethrows the original error verbatim. Scanning every occurrence must not loosen the boundary check into a prefix match, which would claim the wrong package is absent
   */
  test("rethrows when only a prefix-sharing package is missing", async () => {
    const cause = Object.assign(
      new Error(
        "Cannot find package '@scope/pkg-extra' imported from /app/a.js",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );

    await expect(
      loadOptionalPeer(
        async () => {
          throw cause;
        },
        { consumer: "fake adapter", packageName: "@scope/pkg" },
      ),
    ).rejects.toBe(cause);
  });

  /**
   * @case Error preserves cause and brand
   * @preconditions Loader rejects with a missing-module error
   * @expectedResult Thrown error is a branded RoutecraftError carrying the original cause
   */
  test("wraps the original error as cause and is brand-detectable", async () => {
    const cause = Object.assign(
      new Error("Cannot find package 'fake-pkg' imported from /tmp/runner.ts"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    let thrown: unknown;
    try {
      await loadOptionalPeer(
        async () => {
          throw cause;
        },
        { consumer: "fake adapter", packageName: "fake-pkg" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(isRoutecraftError(thrown)).toBe(true);
    expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  /**
   * @case Loader throws an unrelated error (package installed but throws during init)
   * @preconditions Loader rejects with an Error that has no MODULE_NOT_FOUND code (e.g. ESM/CJS interop bug, native binding crash)
   * @expectedResult The original error is rethrown unchanged; not rewrapped as RC5017
   */
  test("rethrows non-missing errors verbatim", async () => {
    const cause = new Error("native binding crashed during init");
    let thrown: unknown;
    try {
      await loadOptionalPeer(
        async () => {
          throw cause;
        },
        { consumer: "fake adapter", packageName: "fake-pkg" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(cause);
    expect(isRoutecraftError(thrown)).toBe(false);
  });

  /**
   * @case Loader throws ERR_MODULE_NOT_FOUND for a transitive dependency, not the requested peer
   * @preconditions The peer is installed but its own dynamic-import chain is missing a different package
   * @expectedResult The original error is rethrown unchanged; not misreported as "install fake-pkg"
   */
  test("rethrows ERR_MODULE_NOT_FOUND when the missing module is a transitive dep", async () => {
    const cause = Object.assign(
      new Error(
        "Cannot find package 'some-transitive' imported from /node_modules/fake-pkg/dist/index.js",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    let thrown: unknown;
    try {
      await loadOptionalPeer(
        async () => {
          throw cause;
        },
        { consumer: "fake adapter", packageName: "fake-pkg" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(cause);
    expect(isRoutecraftError(thrown)).toBe(false);
  });
});
