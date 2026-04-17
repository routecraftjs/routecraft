import { describe, test, expect, vi } from "vitest";
import { jwks } from "../../src/auth/jwks.ts";

vi.mock("jose", () => {
  throw new Error("Cannot find module 'jose'");
});

describe("jwks() without jose installed", () => {
  /**
   * @case Validator surfaces a clear install hint when `jose` cannot be resolved
   * @preconditions `jose` import is mocked to throw a module-not-found error
   * @expectedResult Validator rejects with a message instructing `pnpm add jose`
   */
  test("rejects with install hint when jose is missing", async () => {
    const { validator } = jwks({
      jwksUrl: "http://localhost/jwks.json",
      issuer: "https://idp.example.com",
      audience: "https://mcp.example.com",
    });

    await expect(validator("irrelevant-token")).rejects.toThrow(
      /jose.*pnpm add jose/,
    );
  });
});
