import { describe, expect, test } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { buildSdkParams } from "../src/llm/providers/llm-utils.ts";
import { toPromptInput } from "../src/llm/shared.ts";
import type { LlmPromptPart } from "../src/llm/types.ts";

/**
 * What the SDK builds from a parts array, rather than what we believe it
 * builds. `buildSdkParams` produces the object handed to `generateText`, and
 * `generateText` runs its own message assembly before the model sees
 * anything; these tests capture the prompt at the model boundary, which is
 * the last point before the provider's wire format.
 *
 * This file is vitest rather than bun:test on purpose. Bun shares one module
 * registry across the whole run and sibling test files replace both `ai` and
 * the provider barrel via `mock.module`, so a real dispatch there reads
 * whichever stub loaded first. Vitest isolates per file.
 */

/** The prompt a model was actually called with, at the provider boundary. */
type CapturedPrompt = Array<{ role: string; content: unknown }>;

async function promptSeenByModel(
  user: string | LlmPromptPart[],
  supportedUrls: Record<string, RegExp[]> = {},
): Promise<CapturedPrompt> {
  let captured: CapturedPrompt = [];
  const model = new MockLanguageModelV3({
    supportedUrls,
    doGenerate: async (options: { prompt: unknown }) => {
      captured = options.prompt as CapturedPrompt;
      return {
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        content: [{ type: "text" as const, text: "ok" }],
        warnings: [],
      };
    },
  });

  const params = buildSdkParams({
    model,
    provider: "custom",
    options: { temperature: 0, maxTokens: 16 },
    system: "",
    user: toPromptInput(user),
    extras: {},
  });
  await generateText(params as Parameters<typeof generateText>[0]);
  return captured;
}

describe("content parts reach the model as one multimodal user message", () => {
  /**
   * @case A recording and an instruction reach the model together, with no transcription step
   * @preconditions user resolves to [{ type: "file", data: bytes, mediaType: "audio/ogg" }, { type: "text", text }]
   * @expectedResult One user message whose content is the file part with its bytes and media type intact, followed by the text part
   */
  test("a file part and a text part arrive as one user message", async () => {
    const audio = new Uint8Array([1, 2, 3]);
    const prompt = await promptSeenByModel([
      { type: "file", data: audio, mediaType: "audio/ogg" },
      { type: "text", text: "Answer the question in the recording." },
    ]);

    expect(prompt).toHaveLength(1);
    expect(prompt[0]!.role).toBe("user");
    expect(prompt[0]!.content).toEqual([
      { type: "file", mediaType: "audio/ogg", data: audio },
      { type: "text", text: "Answer the question in the recording." },
    ]);
  });

  /**
   * @case A file part keeps its filename and accepts base64 data
   * @preconditions user resolves to a single file part with base64 string data and a filename
   * @expectedResult The provider sees the same base64 payload, media type and filename
   */
  test("a base64 file part keeps its media type and filename", async () => {
    const prompt = await promptSeenByModel([
      {
        type: "file",
        data: "AQID",
        mediaType: "application/pdf",
        filename: "report.pdf",
      },
    ]);

    expect(prompt[0]!.content).toEqual([
      {
        type: "file",
        mediaType: "application/pdf",
        filename: "report.pdf",
        data: "AQID",
      },
    ]);
  });

  /**
   * @case An image part carries its bytes through under the declared media type
   * @preconditions user resolves to [{ type: "image", image: bytes, mediaType: "image/png" }]
   * @expectedResult The provider sees a file part carrying those bytes; the SDK normalises image parts to file parts at its own boundary
   */
  test("an image part reaches the provider as a file part with its bytes", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const prompt = await promptSeenByModel([
      { type: "image", image: png, mediaType: "image/png" },
    ]);

    expect(prompt[0]!.content).toEqual([
      { type: "file", mediaType: "image/png", data: png },
    ]);
  });

  /**
   * @case A URL part is handed to a provider that declares support for it, rather than downloaded
   * @preconditions An image part whose image is a URL, against a model whose supportedUrls matches it
   * @expectedResult The URL reaches the provider verbatim; a provider that does NOT declare the URL makes the SDK fetch it in-process instead, which is why the reference page says so
   */
  test("a URL part passes through to a provider that supports URLs", async () => {
    const prompt = await promptSeenByModel(
      [{ type: "image", image: new URL("https://example.com/cat.png") }],
      { "image/*": [/^https:\/\/.*/] },
    );

    // Asserted field by field rather than with a whole-object match: this is
    // the one branch where the SDK also emits absent optional keys.
    const parts = prompt[0]!.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!["type"]).toBe("file");
    expect(parts[0]!["mediaType"]).toBe("image/*");
    expect(String(parts[0]!["data"])).toBe("https://example.com/cat.png");
  });

  /**
   * @case A string prompt is untouched by the parts work
   * @preconditions user is a plain string, the form every existing route uses
   * @expectedResult The model sees the same single text part it saw before content parts existed
   */
  test("a string prompt still arrives as one text part", async () => {
    const prompt = await promptSeenByModel("just text");

    expect(prompt).toHaveLength(1);
    expect(prompt[0]!.content).toEqual([{ type: "text", text: "just text" }]);
  });
});
