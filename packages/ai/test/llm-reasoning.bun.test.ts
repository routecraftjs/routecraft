import { describe, expect, test } from "bun:test";
import { buildSdkParams } from "../src/llm/providers/llm-utils.ts";
import {
  mergeProviderOptions,
  reasoningProviderOptions,
} from "../src/llm/providers/reasoning.ts";
import type {
  LlmProviderType,
  LlmRawProviderOptions,
  LlmReasoningEffort,
  LlmSamplingOptionsMerged,
} from "../src/llm/types.ts";

/**
 * `buildSdkParams` is the object handed to `generateText` / `streamText`, so
 * asserting on what it returns is asserting on what the provider is asked
 * for. The reasoning mapping and the `providerOptions` passthrough both land
 * here, and both used to have nowhere to land: the SDK params were assembled
 * from a fixed list of sampling fields.
 */

/** Sampling block as it reaches the provider call, with the defaults applied. */
function sampling(
  extra: Partial<LlmSamplingOptionsMerged> = {},
): LlmSamplingOptionsMerged {
  return { temperature: 0, maxTokens: 1024, ...extra };
}

function paramsFor(
  provider: LlmProviderType,
  extra: Partial<LlmSamplingOptionsMerged>,
): Record<string, unknown> {
  return buildSdkParams({}, provider, sampling(extra), "", "hi", {});
}

function providerOptionsFor(
  provider: LlmProviderType,
  extra: Partial<LlmSamplingOptionsMerged>,
): LlmRawProviderOptions | undefined {
  return paramsFor(provider, extra)["providerOptions"] as
    LlmRawProviderOptions | undefined;
}

describe("reasoning effort maps to each provider's own control", () => {
  /**
   * @case Every provider with a reasoning control receives it for a mid-scale level
   * @preconditions reasoning: "medium" on the sampling block, one case per provider id
   * @expectedResult Each provider's SDK params carry that provider's namespace and its own control name and value
   */
  test("medium reaches every mapped provider under its own key", () => {
    expect(providerOptionsFor("openai", { reasoning: "medium" })).toEqual({
      openai: { reasoningEffort: "medium" },
    });
    expect(providerOptionsFor("anthropic", { reasoning: "medium" })).toEqual({
      anthropic: { effort: "medium" },
    });
    expect(providerOptionsFor("gemini", { reasoning: "medium" })).toEqual({
      google: { thinkingConfig: { thinkingLevel: "medium" } },
    });
    expect(providerOptionsFor("openrouter", { reasoning: "medium" })).toEqual({
      openrouter: { reasoning: { effort: "medium" } },
    });
    expect(providerOptionsFor("ollama", { reasoning: "medium" })).toEqual({
      ollama: { think: true },
    });
    expect(providerOptionsFor("lmstudio", { reasoning: "medium" })).toEqual({
      lmstudio: { reasoningEffort: "medium" },
    });
  });

  /**
   * @case "none" turns reasoning off where a provider can, and lands on its nearest level where it cannot
   * @preconditions reasoning: "none", one case per provider id
   * @expectedResult OpenAI, OpenRouter and Ollama switch it off; Anthropic sends thinking disabled rather than an effort; Gemini, which has no off, sends its lowest level
   */
  test('"none" disables where possible and degrades where not', () => {
    expect(providerOptionsFor("openai", { reasoning: "none" })).toEqual({
      openai: { reasoningEffort: "none" },
    });
    expect(providerOptionsFor("openrouter", { reasoning: "none" })).toEqual({
      openrouter: { reasoning: { effort: "none" } },
    });
    expect(providerOptionsFor("ollama", { reasoning: "none" })).toEqual({
      ollama: { think: false },
    });
    expect(providerOptionsFor("anthropic", { reasoning: "none" })).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    });
    expect(providerOptionsFor("gemini", { reasoning: "none" })).toEqual({
      google: { thinkingConfig: { thinkingLevel: "minimal" } },
    });
  });

  /**
   * @case An unmappable level is degraded rather than refused
   * @preconditions Every level asked of every provider
   * @expectedResult No call throws, and only the custom provider maps to nothing
   */
  test("no level throws on any provider", () => {
    const levels: LlmReasoningEffort[] = ["none", "low", "medium", "high"];
    const providers: LlmProviderType[] = [
      "openai",
      "anthropic",
      "gemini",
      "openrouter",
      "ollama",
      "lmstudio",
      "custom",
    ];
    for (const provider of providers) {
      for (const level of levels) {
        const mapped = reasoningProviderOptions(provider, level);
        expect(mapped === undefined).toBe(provider === "custom");
      }
    }
  });

  /**
   * @case A custom provider's model handle has no namespace to map onto
   * @preconditions provider "custom" with reasoning: "high" and no providerOptions
   * @expectedResult No providerOptions key is added to the SDK params at all
   */
  test("custom maps nothing and adds no providerOptions", () => {
    expect(paramsFor("custom", { reasoning: "high" })).not.toHaveProperty(
      "providerOptions",
    );
  });

  /**
   * @case Reasoning left unset sends nothing, so the provider's own default applies
   * @preconditions Sampling block with neither reasoning nor providerOptions
   * @expectedResult SDK params carry no providerOptions key
   */
  test("no reasoning and no passthrough sends no providerOptions", () => {
    expect(paramsFor("openai", {})).not.toHaveProperty("providerOptions");
  });
});

describe("providerOptions passthrough and precedence", () => {
  /**
   * @case A raw passthrough reaches the SDK params on its own
   * @preconditions providerOptions naming a setting the framework has no opinion about, no reasoning
   * @expectedResult The object is forwarded verbatim
   */
  test("passthrough alone is forwarded verbatim", () => {
    expect(
      providerOptionsFor("anthropic", {
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
        },
      }),
    ).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
    });
  });

  /**
   * @case providerOptions wins over the mapped reasoning for the setting it names
   * @preconditions reasoning: "low" and a providerOptions naming the same provider's thinking control
   * @expectedResult The authored value is sent; the mapped one is gone rather than merged beside it
   */
  test("an authored setting replaces the mapped one", () => {
    expect(
      providerOptionsFor("anthropic", {
        reasoning: "low",
        providerOptions: {
          anthropic: { effort: "max" },
        },
      }),
    ).toEqual({ anthropic: { effort: "max" } });

    expect(
      providerOptionsFor("gemini", {
        reasoning: "high",
        providerOptions: {
          google: { thinkingConfig: { thinkingBudget: 2048 } },
        },
      }),
    ).toEqual({ google: { thinkingConfig: { thinkingBudget: 2048 } } });
  });

  /**
   * @case A passthrough setting beside the mapped one keeps both
   * @preconditions reasoning: "high" on gemini plus providerOptions naming a different setting in the same namespace
   * @expectedResult The mapped thinkingConfig and the authored safetySettings are both present
   */
  test("an unrelated authored setting merges beside the mapped one", () => {
    expect(
      providerOptionsFor("gemini", {
        reasoning: "high",
        providerOptions: { google: { cachedContent: "cache-key" } },
      }),
    ).toEqual({
      google: {
        thinkingConfig: { thinkingLevel: "high" },
        cachedContent: "cache-key",
      },
    });
  });

  /**
   * @case A passthrough for another provider does not disturb the mapped namespace
   * @preconditions reasoning: "low" on openai plus providerOptions under an unrelated namespace
   * @expectedResult Both namespaces are present with their own settings
   */
  test("namespaces are merged independently", () => {
    expect(
      providerOptionsFor("openai", {
        reasoning: "low",
        providerOptions: { openrouter: { user: "u-1" } },
      }),
    ).toEqual({
      openai: { reasoningEffort: "low" },
      openrouter: { user: "u-1" },
    });
  });

  /**
   * @case The merge does not mutate the mapped or authored objects
   * @preconditions An authored providerOptions object reused across two calls
   * @expectedResult The authored object is unchanged after merging, so a shared options object cannot accumulate mapped settings
   */
  test("merging leaves its inputs alone", () => {
    const authored: LlmRawProviderOptions = { google: { cachedContent: "c" } };
    const merged = mergeProviderOptions(
      { google: { thinkingConfig: { thinkingLevel: "low" } } },
      authored,
    );
    expect(merged).not.toBe(authored);
    expect(authored).toEqual({ google: { cachedContent: "c" } });
  });
});

describe("buildSdkParams carries the whole sampling block", () => {
  /**
   * @case Sampling values and reasoning travel together into one SDK params object
   * @preconditions Every sampling field set, on a provider with a reasoning mapping
   * @expectedResult Each field appears under the SDK's own name, and providerOptions sits beside them
   */
  test("every sampling field reaches the SDK params", () => {
    const params = buildSdkParams(
      { id: "model" },
      "openai",
      {
        temperature: 0.7,
        maxTokens: 512,
        topP: 0.9,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
        reasoning: "high",
      },
      "be brief",
      "hello",
      {},
    );
    expect(params).toMatchObject({
      temperature: 0.7,
      maxOutputTokens: 512,
      topP: 0.9,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      system: "be brief",
      prompt: "hello",
      providerOptions: { openai: { reasoningEffort: "high" } },
    });
  });
});
