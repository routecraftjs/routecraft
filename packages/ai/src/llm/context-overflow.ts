import { rcError } from "@routecraft/routecraft";
// Registers AI1009, thrown from the classifier below.
import "../errors.ts";

/**
 * Telling "the prompt does not fit" apart from every other way a model call
 * can fail.
 *
 * The two need different reactions and nothing else can tell them apart. A
 * transient provider failure is worth a retry with the same input; a full
 * context window is not, because the same input will never fit. A caller
 * that cannot distinguish them either retries a request that can only fail
 * again, or gives up on one that would have succeeded.
 *
 * Providers do not agree on how to say it. There is no shared status code
 * (the SDK surfaces a 400 for most, and some local runtimes answer 500),
 * and only OpenAI-compatible endpoints carry a machine-readable
 * `context_length_exceeded`. So the classifier reads the structured code
 * where there is one and falls back to matching the phrasings the
 * providers actually emit, quoted below next to the provider that emits
 * them. It is deliberately narrow: a false positive tells a caller to
 * shorten a prompt that was never too long, and hides the real failure.
 */

/**
 * Machine-readable codes that mean exactly this failure. OpenAI's is the
 * one every OpenAI-compatible gateway copies.
 */
const OVERFLOW_CODES = new Set([
  "context_length_exceeded",
  "string_above_max_length",
]);

/**
 * Phrasings providers use for a prompt that does not fit.
 *
 * - "prompt is too long: 250000 tokens > 200000 maximum" (Anthropic)
 * - "This model's maximum context length is 128000 tokens" (OpenAI)
 * - "The input token count (1200000) exceeds the maximum number of tokens
 *   allowed" (Google)
 * - "requested tokens exceed context window" (Ollama, llama.cpp)
 */
const OVERFLOW_PHRASES =
  /(prompt is too long|maximum context length|context length exceeded|exceeds? the (?:maximum )?context|exceed(?:s)? context window|input token count \(\d+\) exceeds|too many (?:input )?tokens|reduce the length of the messages)/i;

/**
 * Pull the strings worth matching out of an error and its cause chain.
 *
 * The provider's own wording routinely survives only in a nested cause or
 * in the raw `responseBody` the SDK attached, so matching `error.message`
 * alone misses the majority of real cases.
 */
function textOf(error: unknown, depth = 0): string[] {
  if (error === null || typeof error !== "object" || depth > 4) {
    return typeof error === "string" ? [error] : [];
  }
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["message", "responseBody"]) {
    const value = record[key];
    if (typeof value === "string") parts.push(value);
  }
  for (const key of ["cause", "data", "error"]) {
    if (record[key] !== undefined)
      parts.push(...textOf(record[key], depth + 1));
  }
  return parts;
}

/**
 * Read a provider error code out of an error and its cause chain. Both
 * `error.code` and the `{ error: { code } }` body shape OpenAI-compatible
 * endpoints return are checked.
 */
function codesOf(error: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  // The SDK attaches the provider's body as an unparsed string, and for an
  // OpenAI-compatible endpoint that string is where the machine-readable
  // code lives. Reading it as prose misses it: `context_length_exceeded`
  // does not match the phrasings, which are written with spaces.
  if (typeof error === "string") {
    const parsed = parseJson(error);
    return parsed === undefined ? [] : codesOf(parsed, depth + 1);
  }
  if (error === null || typeof error !== "object") return [];
  const record = error as Record<string, unknown>;
  const codes: string[] = [];
  if (typeof record["code"] === "string") codes.push(record["code"]);
  for (const key of ["cause", "data", "error", "responseBody"]) {
    if (record[key] !== undefined)
      codes.push(...codesOf(record[key], depth + 1));
  }
  return codes;
}

/**
 * `JSON.parse` that answers `undefined` rather than throwing. A response
 * body is not always JSON, and a body that is not is simply not a source of
 * codes.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Whether a failed model dispatch failed because the prompt did not fit the
 * model's context window.
 *
 * @param error - Whatever the provider call threw
 */
export function isContextOverflow(error: unknown): boolean {
  if (codesOf(error).some((code) => OVERFLOW_CODES.has(code))) return true;
  return textOf(error).some((text) => OVERFLOW_PHRASES.test(text));
}

/**
 * Rethrow a failed model dispatch, as `AI1009` when the failure was the
 * context window and untouched otherwise.
 *
 * Untouched rather than wrapped, deliberately: every other model failure
 * already reaches the route's error channel with the provider's own error
 * and its retryability intact, and re-wrapping the lot to relabel one of
 * them would change behaviour for every caller.
 *
 * @throws AI1009 when the prompt did not fit
 */
export function rethrowContextOverflow(error: unknown): never {
  if (isContextOverflow(error)) {
    throw rcError("AI1009", error, {
      message:
        "The model refused the request because the prompt exceeds its context window. Send less: compact the conversation, trim what the thread carries, or move to a model with a larger window.",
    });
  }
  throw error;
}
