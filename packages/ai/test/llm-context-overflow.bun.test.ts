import { describe, expect, test } from "bun:test";
import {
  isContextOverflow,
  rethrowContextOverflow,
} from "../src/llm/context-overflow.ts";

/**
 * The wire shape the Vercel AI SDK's `APICallError` presents: the provider's
 * own words survive on `responseBody` and on a nested `data.error`, not
 * always on `message`.
 */
function apiError(options: {
  message?: string;
  responseBody?: string;
  code?: string;
}): Error & Record<string, unknown> {
  const error = new Error(options.message ?? "Bad Request") as Error &
    Record<string, unknown>;
  if (options.responseBody !== undefined) {
    error["responseBody"] = options.responseBody;
  }
  if (options.code !== undefined) {
    error["data"] = { error: { code: options.code } };
  }
  return error;
}

describe("isContextOverflow", () => {
  /**
   * @case Anthropic's phrasing is recognised
   * @preconditions An error whose message is "prompt is too long: 250000 tokens > 200000 maximum"
   * @expectedResult true, so the caller compacts instead of retrying an input that can never fit
   */
  test("recognises Anthropic's prompt-is-too-long", () => {
    expect(
      isContextOverflow(
        apiError({
          message: "prompt is too long: 250000 tokens > 200000 maximum",
        }),
      ),
    ).toBe(true);
  });

  /**
   * @case OpenAI's machine-readable code is recognised
   * @preconditions An error carrying data.error.code = context_length_exceeded
   * @expectedResult true, read from the code rather than from the prose
   */
  test("recognises the context_length_exceeded code", () => {
    expect(
      isContextOverflow(apiError({ code: "context_length_exceeded" })),
    ).toBe(true);
  });

  /**
   * @case Google's phrasing inside a response body is recognised
   * @preconditions The provider's words survive only on responseBody
   * @expectedResult true, because matching error.message alone misses most real cases
   */
  test("recognises a phrasing carried only on responseBody", () => {
    expect(
      isContextOverflow(
        apiError({
          message: "Bad Request",
          responseBody:
            '{"error":{"message":"The input token count (1200000) exceeds the maximum number of tokens allowed"}}',
        }),
      ),
    ).toBe(true);
  });

  /**
   * @case A nested cause is searched
   * @preconditions The overflow message sits on error.cause, not on the error itself
   * @expectedResult true, so a wrapped provider error is still classified
   */
  test("searches the cause chain", () => {
    const wrapped = new Error("dispatch failed", {
      cause: apiError({
        message: "This model's maximum context length is 128000 tokens",
      }),
    });
    expect(isContextOverflow(wrapped)).toBe(true);
  });

  /**
   * @case A machine-readable code inside an unparsed response body is found
   * @preconditions The provider sent only `{"error":{"code":"context_length_exceeded"}}` as the body, with no prose to match
   * @expectedResult Classified, because the underscored code never matches the phrasings, which are written with spaces
   */
  test("parses a JSON response body for the provider code", () => {
    const error = new Error("Bad Request") as Error & Record<string, unknown>;
    error["responseBody"] = JSON.stringify({
      error: { code: "context_length_exceeded" },
    });
    expect(isContextOverflow(error)).toBe(true);
  });

  /**
   * @case A response body that is not JSON is not a source of codes
   * @preconditions A body of plain text
   * @expectedResult No throw, and no classification from the body alone
   */
  test("tolerates a response body that is not JSON", () => {
    const error = new Error("Bad Gateway") as Error & Record<string, unknown>;
    error["responseBody"] = "<html>502</html>";
    expect(isContextOverflow(error)).toBe(false);
  });

  /**
   * @case An ordinary provider failure is not classified as overflow
   * @preconditions A rate-limit error
   * @expectedResult false, because a false positive tells a caller to shorten a prompt that was never too long and hides the real failure
   */
  test("leaves an unrelated failure alone", () => {
    expect(
      isContextOverflow(
        apiError({ message: "Rate limit reached for requests" }),
      ),
    ).toBe(false);
  });

  /**
   * @case A non-error value is handled
   * @preconditions A thrown string and a thrown null
   * @expectedResult false rather than a throw from the classifier itself
   */
  test("tolerates values that are not errors", () => {
    expect(isContextOverflow("boom")).toBe(false);
    expect(isContextOverflow(null)).toBe(false);
  });
});

describe("rethrowContextOverflow", () => {
  /**
   * @case An overflow is rethrown as AI1009 with the provider error as cause
   * @preconditions A provider error whose message says the prompt is too long
   * @expectedResult AI1009, so callers can branch on the code instead of matching provider prose themselves
   */
  test("rethrows an overflow as AI1009", () => {
    const cause = apiError({
      message: "prompt is too long: 9 tokens > 8 maximum",
    });
    expect(() => rethrowContextOverflow(cause)).toThrow(
      expect.objectContaining({ rc: "AI1009", cause }),
    );
  });

  /**
   * @case Every other failure is rethrown untouched
   * @preconditions A rate-limit error
   * @expectedResult The identical error object, so retryability and the provider's own type survive
   */
  test("rethrows an unrelated failure unchanged", () => {
    const cause = apiError({ message: "Rate limit reached for requests" });
    // toBe, not toThrow: the contract is that the original object comes back,
    // not merely one that matches it.
    let thrown: unknown;
    try {
      rethrowContextOverflow(cause);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(cause);
  });
});
