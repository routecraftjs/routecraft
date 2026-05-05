import { afterEach, describe, expect, test } from "bun:test";
import { jwks, __jwksLoaders } from "../../src/auth/jwks.ts";
import { rcError } from "../../src/error.ts";

// The validator goes through `__jwksLoaders.loadJose()` which normally
// dispatches to `loadOptionalPeer(() => import("jose"), ...)`. Replacing
// the loader directly is far cleaner than `vi.mock("jose", () => { throw })`,
// which vitest 4 wraps in a generic "There was an error when mocking a
// module" error -- defeating loadOptionalPeer's package-name discriminator.
describe("jwks() without jose installed", () => {
  const original = __jwksLoaders.loadJose;
  afterEach(() => {
    __jwksLoaders.loadJose = original;
  });

  /**
   * @case Validator surfaces a clear install hint when `jose` cannot be resolved
   * @preconditions `__jwksLoaders.loadJose` is overridden to reject with the same RC5017 the production loader would surface for a missing peer
   * @expectedResult Validator rejects with a message instructing `bun add jose`
   */
  test("rejects with install hint when jose is missing", async () => {
    __jwksLoaders.loadJose = () =>
      Promise.reject(
        rcError("RC5017", undefined, {
          message:
            'jwks adapter requires the optional peer dependency "jose". Install it: bun add jose (or npm install jose).',
        }),
      );

    const { validator } = jwks({
      jwksUrl: "http://localhost/jwks.json",
      issuer: "https://idp.example.com",
      audience: "https://mcp.example.com",
    });

    await expect(validator("irrelevant-token")).rejects.toThrow(
      /jose.*bun add jose/,
    );
  });
});
