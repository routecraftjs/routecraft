import type {
  LlmRawProviderOptions,
  LlmProviderType,
  LlmReasoningEffort,
} from "../types.ts";

/**
 * The SDK provider namespace `providerOptions` is keyed by, which is not
 * always the Routecraft provider id. Gemini reaches the SDK through
 * `@ai-sdk/google`, and the openai-compatible provider derives its namespace
 * from the name the factory is constructed with, which is why LM Studio's
 * namespace and its `createOpenAICompatible({ name })` come from one constant.
 *
 * @internal
 */
export const LMSTUDIO_PROVIDER_NAME = "lmstudio";

/**
 * Map a normalised reasoning level onto the provider's own control.
 *
 * The table, and what each provider actually accepts (read off the installed
 * SDKs' own option schemas):
 *
 * | Provider | Control | `none` | `low` / `medium` / `high` |
 * | --- | --- | --- | --- |
 * | `openai` | `reasoningEffort` | `"none"` | the level verbatim |
 * | `anthropic` | `thinking` / `effort` | `thinking: { type: "disabled" }` | `effort: <level>` |
 * | `gemini` | `thinkingConfig.thinkingLevel` | `"minimal"` | the level verbatim |
 * | `openrouter` | `reasoning.effort` | `"none"` | the level verbatim |
 * | `ollama` | `think` | `false` | `true` |
 * | `lmstudio` | `reasoningEffort` | the level verbatim | the level verbatim |
 * | `custom` | none | not mapped | not mapped |
 *
 * Three of those are lossy, and the loss is the honest part of the contract:
 *
 * - Gemini's `thinkingLevel` has no off switch, so `"none"` reaches it as
 *   `"minimal"`, its lowest setting. A Gemini model still thinks a little.
 * - Ollama's control is a boolean, so `low`, `medium` and `high` are one
 *   value there and differ only in what the model does with the prompt.
 * - LM Studio forwards the string to whatever server is behind it, so the
 *   level is only meaningful when the loaded model reads it.
 *
 * The table says what is sent, not what every model behind a provider id
 * accepts. Each level is forwarded as that provider's own reasoning setting
 * and the API is what refuses an unsupported one, which applies to `none`
 * where it is forwarded verbatim as much as to Anthropic's `effort`.
 *
 * Anthropic's `effort` is an `output_config` field, so it needs a model new
 * enough to accept one; the SDK sends it either way and the API is what
 * refuses. That is the one row here not established by executing the path,
 * only by reading the SDK's schema.
 *
 * `custom` maps nothing: the model handle is supplied by the author, so the
 * framework cannot know which namespace its settings belong under.
 * `providerOptions` is the way to reach it.
 *
 * @internal
 */
export function reasoningProviderOptions(
  provider: LlmProviderType,
  level: LlmReasoningEffort,
): LlmRawProviderOptions | undefined {
  switch (provider) {
    case "openai":
      return { openai: { reasoningEffort: level } };
    case "anthropic":
      return level === "none"
        ? { anthropic: { thinking: { type: "disabled" } } }
        : { anthropic: { effort: level } };
    case "gemini":
      return {
        google: {
          thinkingConfig: {
            thinkingLevel: level === "none" ? "minimal" : level,
          },
        },
      };
    case "openrouter":
      return { openrouter: { reasoning: { effort: level } } };
    case "ollama":
      return { ollama: { think: level !== "none" } };
    case "lmstudio":
      return { [LMSTUDIO_PROVIDER_NAME]: { reasoningEffort: level } };
    case "custom":
      return undefined;
  }
}

/**
 * Fold authored `providerOptions` over whatever `reasoning` mapped to.
 *
 * The merge is two levels deep, namespace then setting, so naming one setting
 * replaces the mapped setting of the same name and leaves the rest of the
 * namespace alone. A value nested deeper than that (the contents of a
 * `thinkingConfig`, say) is replaced wholesale, which is what makes the
 * precedence readable: the authored value for a setting is the value sent.
 *
 * @internal
 */
export function mergeProviderOptions(
  mapped: LlmRawProviderOptions | undefined,
  authored: LlmRawProviderOptions | undefined,
): LlmRawProviderOptions | undefined {
  if (mapped === undefined && authored === undefined) return undefined;
  // Null-prototype accumulator so a namespace named `__proto__`, which a
  // config loaded from JSON or YAML can carry, lands as an own key instead of
  // reassigning the prototype of the object handed to the SDK. Same guard as
  // `mergeBlocks` in the agent enricher.
  const out = Object.assign(
    Object.create(null) as LlmRawProviderOptions,
    mapped,
  );
  for (const [namespace, settings] of Object.entries(authored ?? {})) {
    out[namespace] = { ...out[namespace], ...settings };
  }
  return out;
}
