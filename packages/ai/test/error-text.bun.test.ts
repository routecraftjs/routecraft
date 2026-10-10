import { describe, expect, test } from "bun:test";
import { errorMessage, errorName } from "../src/agent/error-text.ts";

describe("error text of a failed tool call", () => {
  /**
   * @case A thrown value with no string form, or an accessor that throws, still reads as text
   * @preconditions A null-prototype object, which String() cannot convert; an Error whose message getter throws
   * @expectedResult errorMessage returns a fallback naming the thrown value's type instead of throwing
   */
  test("errorMessage never throws", () => {
    const bare = Object.create(null) as object;
    const hostile = new Error("unused");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("getter");
      },
    });
    expect(() => String(bare)).toThrow();
    expect(errorMessage(bare)).toBe(
      "A thrown object that could not be read as text",
    );
    expect(errorMessage(hostile)).toBe(
      "A thrown object that could not be read as text",
    );
    expect(errorMessage({ message: "plain" })).toBe("plain");
    expect(errorMessage(new TypeError("typed"))).toBe("typed");
  });

  /**
   * @case Only an identifier-shaped error name is kept as the classifier persisted outside the snapshot
   * @preconditions A built-in and a custom class name; a name rewritten to carry text; a name getter that throws; a non-Error value
   * @expectedResult Class names pass through; the rewritten and throwing names read as "Error"; a non-Error reads as its typeof
   */
  test("errorName keeps class names and nothing else", () => {
    class MailRelayError extends Error {
      override name = "MailRelayError";
    }
    const leaky = new Error("refused");
    leaky.name = "Rejected alice@example.com";
    const hostile = new Error("unused");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("getter");
      },
    });
    expect(errorName(new TypeError("x"))).toBe("TypeError");
    expect(errorName(new MailRelayError("x"))).toBe("MailRelayError");
    expect(errorName(leaky)).toBe("Error");
    expect(errorName(hostile)).toBe("Error");
    expect(errorName("a string")).toBe("string");
  });
});
