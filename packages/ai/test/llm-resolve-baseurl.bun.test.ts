import { describe, expect, mock, test } from "bun:test";

// Capture the settings each provider factory receives so the tests can
// assert what `resolveLanguageModel` forwards. The mocks are registered at
// file load (before the dynamic `import()` inside resolve.ts runs), and bun
// shares one module registry across the test run, so calls made while THIS
// file's tests run resolve to these stubs.
const anthropicSettingsSeen: Array<Record<string, unknown>> = [];
const googleSettingsSeen: Array<Record<string, unknown>> = [];

mock.module("@ai-sdk/anthropic", () => ({
  createAnthropic: (settings: Record<string, unknown>) => {
    anthropicSettingsSeen.push(settings);
    return function model() {
      return { doGenerate: () => null, doStream: () => null };
    };
  },
}));

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: (settings: Record<string, unknown>) => {
    googleSettingsSeen.push(settings);
    return function model() {
      return { doGenerate: () => null, doStream: () => null };
    };
  },
}));

import { resolveLanguageModel } from "../src/llm/providers/resolve.ts";

describe("provider baseURL forwarding (anthropic, gemini)", () => {
  /**
   * @case A configured anthropic baseURL is forwarded to createAnthropic
   * @preconditions Anthropic config with apiKey and baseURL
   * @expectedResult createAnthropic receives both apiKey and baseURL, so the
   *   explicit config wins over the SDK's ANTHROPIC_BASE_URL env fallback
   */
  test("anthropic config baseURL reaches createAnthropic", async () => {
    anthropicSettingsSeen.length = 0;
    await resolveLanguageModel(
      {
        provider: "anthropic",
        apiKey: "sk-test",
        baseURL: "https://gateway.example.com/v1",
      },
      "claude-sonnet-4-6",
    );
    expect(anthropicSettingsSeen).toEqual([
      { apiKey: "sk-test", baseURL: "https://gateway.example.com/v1" },
    ]);
  });

  /**
   * @case An anthropic config without baseURL omits the key entirely
   * @preconditions Anthropic config with apiKey only
   * @expectedResult createAnthropic receives no baseURL property (not even
   *   `undefined`), preserving the SDK's own default resolution
   */
  test("anthropic config without baseURL does not pass the key", async () => {
    anthropicSettingsSeen.length = 0;
    await resolveLanguageModel(
      { provider: "anthropic", apiKey: "sk-test" },
      "claude-sonnet-4-6",
    );
    expect(anthropicSettingsSeen).toHaveLength(1);
    expect("baseURL" in anthropicSettingsSeen[0]).toBe(false);
  });

  /**
   * @case A configured gemini baseURL is forwarded to createGoogleGenerativeAI
   * @preconditions Gemini config with apiKey and baseURL
   * @expectedResult createGoogleGenerativeAI receives both apiKey and baseURL
   */
  test("gemini config baseURL reaches createGoogleGenerativeAI", async () => {
    googleSettingsSeen.length = 0;
    await resolveLanguageModel(
      {
        provider: "gemini",
        apiKey: "g-test",
        baseURL: "https://gateway.example.com/gemini",
      },
      "gemini-2.5-flash",
    );
    expect(googleSettingsSeen).toEqual([
      { apiKey: "g-test", baseURL: "https://gateway.example.com/gemini" },
    ]);
  });

  /**
   * @case A gemini config without baseURL omits the key entirely
   * @preconditions Gemini config with apiKey only
   * @expectedResult createGoogleGenerativeAI receives no baseURL property
   */
  test("gemini config without baseURL does not pass the key", async () => {
    googleSettingsSeen.length = 0;
    await resolveLanguageModel(
      { provider: "gemini", apiKey: "g-test" },
      "gemini-2.5-flash",
    );
    expect(googleSettingsSeen).toHaveLength(1);
    expect("baseURL" in googleSettingsSeen[0]).toBe(false);
  });
});
