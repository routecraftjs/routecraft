import { describe, expect, mock, test } from "bun:test";
import { llmPlugin } from "../src/index.ts";
import {
  keyedProviderSettings,
  resolveLanguageModel,
} from "../src/llm/providers/resolve.ts";

// Mock the provider SDKs so resolveLanguageModel doesn't try to load the
// optional peers from disk; the mocks record the settings bag each factory
// receives so the tests can assert what the resolver forwarded. Bun shares
// one module registry across the whole `bun test` run, but mocks registered
// here are the freshest while this file's tests execute, and the stub keeps
// the same shape other files rely on (a factory returning a model function).
const anthropicSettings: Array<Record<string, unknown>> = [];
const googleSettings: Array<Record<string, unknown>> = [];

function stubModel(): unknown {
  return { doGenerate: () => null, doStream: () => null };
}

mock.module("@ai-sdk/anthropic", () => ({
  createAnthropic: (settings: Record<string, unknown>) => {
    anthropicSettings.push(settings);
    return () => stubModel();
  },
}));

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: (settings: Record<string, unknown>) => {
    googleSettings.push(settings);
    return () => stubModel();
  },
}));

describe("LLM provider baseURL forwarding", () => {
  /**
   * @case Anthropic config baseURL is forwarded to createAnthropic
   * @preconditions Anthropic config with apiKey and baseURL
   * @expectedResult createAnthropic receives both apiKey and baseURL, so
   *   config beats ambient env vars like ANTHROPIC_BASE_URL
   */
  test("anthropic forwards configured baseURL", async () => {
    anthropicSettings.length = 0;
    await resolveLanguageModel(
      {
        provider: "anthropic",
        apiKey: "sk-test",
        baseURL: "https://proxy.example.com/v1",
      },
      "claude-sonnet-4-6",
    );
    expect(anthropicSettings).toEqual([
      { apiKey: "sk-test", baseURL: "https://proxy.example.com/v1" },
    ]);
  });

  /**
   * @case Anthropic config without baseURL does not set the key
   * @preconditions Anthropic config with apiKey only
   * @expectedResult createAnthropic receives a settings bag without a
   *   baseURL property, preserving the SDK's own env-var/default fallback
   */
  test("anthropic omits baseURL when not configured", async () => {
    anthropicSettings.length = 0;
    await resolveLanguageModel(
      { provider: "anthropic", apiKey: "sk-test" },
      "claude-sonnet-4-6",
    );
    expect(anthropicSettings).toHaveLength(1);
    expect("baseURL" in anthropicSettings[0]!).toBe(false);
  });

  /**
   * @case Gemini config baseURL is forwarded to createGoogleGenerativeAI
   * @preconditions Gemini config with apiKey and baseURL
   * @expectedResult createGoogleGenerativeAI receives both apiKey and baseURL
   */
  test("gemini forwards configured baseURL", async () => {
    googleSettings.length = 0;
    await resolveLanguageModel(
      {
        provider: "gemini",
        apiKey: "g-test",
        baseURL: "https://gemini-proxy.example.com",
      },
      "gemini-2.0-flash",
    );
    expect(googleSettings).toEqual([
      { apiKey: "g-test", baseURL: "https://gemini-proxy.example.com" },
    ]);
  });

  /**
   * @case keyedProviderSettings includes baseURL only when defined
   * @preconditions One config with baseURL, one without
   * @expectedResult The bag carries baseURL only for the config that set it
   */
  test("keyedProviderSettings sets baseURL only when configured", () => {
    expect(
      keyedProviderSettings({ apiKey: "k", baseURL: "https://x.example" }),
    ).toEqual({ apiKey: "k", baseURL: "https://x.example" });
    const bare = keyedProviderSettings({ apiKey: "k" });
    expect(bare).toEqual({ apiKey: "k" });
    expect("baseURL" in bare).toBe(false);
  });

  /**
   * @case llmPlugin accepts an anthropic provider with baseURL
   * @preconditions providers.anthropic has apiKey and a string baseURL
   * @expectedResult Plugin construction does not throw
   */
  test("validation accepts anthropic baseURL", () => {
    expect(() =>
      llmPlugin({
        providers: {
          anthropic: { apiKey: "sk-test", baseURL: "https://x.example" },
        },
      }),
    ).not.toThrow();
  });

  /**
   * @case llmPlugin rejects a non-string anthropic baseURL
   * @preconditions providers.anthropic.baseURL is a number
   * @expectedResult Build throws a TypeError naming baseURL
   */
  test("validation rejects a non-string anthropic baseURL", () => {
    expect(() =>
      llmPlugin({
        // @ts-expect-error baseURL must be a string
        providers: { anthropic: { apiKey: "sk-test", baseURL: 1234 } },
      }),
    ).toThrow(/anthropic"\]\.baseURL/);
  });

  /**
   * @case llmPlugin rejects a non-string gemini baseURL
   * @preconditions providers.gemini.baseURL is a number
   * @expectedResult Build throws a TypeError naming baseURL
   */
  test("validation rejects a non-string gemini baseURL", () => {
    expect(() =>
      llmPlugin({
        // @ts-expect-error baseURL must be a string
        providers: { gemini: { apiKey: "g-test", baseURL: 1234 } },
      }),
    ).toThrow(/gemini"\]\.baseURL/);
  });
});
