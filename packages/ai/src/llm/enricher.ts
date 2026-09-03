import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  getExchangeContext,
  isStandardSchema,
  validateAgainst,
  type CraftContext,
  type Enricher,
  type Exchange,
  type MergedOptions,
} from "@routecraft/routecraft";
import { callLlm } from "./providers/index.ts";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  parseProviderModel,
  resolveModel,
  resolvePrompt,
  resolveSampling,
  resolveUserPrompt,
  resolveUserPromptDefault,
  toPromptInput,
} from "./shared.ts";
import { toAiOutputSpec } from "./structured-output.ts";
import type {
  LlmOptions,
  LlmOptionsMerged,
  LlmResultWithOutput,
} from "./types.ts";
import { ADAPTER_LLM_OPTIONS } from "./types.ts";

/**
 * When the AI SDK doesn't set result.output (e.g. it threw on the getter), try to
 * parse result.text as JSON and validate with the output schema. Returns the
 * validated value, or undefined when there is no fallback to offer: the text is
 * not JSON, the schema is not a Standard Schema, or the schema rejected it.
 *
 * A schema that accepts without returning a `value` yields the parsed JSON,
 * which is `validateAgainst`'s fallback and the reading this path wants: the
 * schema vouched for `parsed`, so `parsed` is the structured output.
 */
async function parseStructuredTextFallback(
  text: string,
  schema: StandardSchemaV1,
): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isStandardSchema(schema)) return undefined;
  const result = await validateAgainst(schema, parsed);
  return result.ok ? result.value : undefined;
}

/**
 * LLM destination adapter. Expects model id as "providerId:modelName" (e.g. ollama:lfm2.5-thinking),
 * resolves the provider from the plugin store, merges options, and calls the provider with the model name.
 * Use with .enrich(llm("providerId:modelName", options)) or .to(llm(...)).
 *
 * @template T - Body type available to prompt callbacks.
 * @template S - Output schema type when an `output` schema is provided; narrows result.output for downstream typing.
 */
export class LlmEnricherAdapter<
  S extends StandardSchemaV1 | undefined = undefined,
  T = unknown,
>
  implements
    Enricher<T, LlmResultWithOutput<S>>,
    MergedOptions<LlmOptionsMerged<T>>
{
  readonly adapterId = "routecraft.adapter.llm";

  constructor(
    private readonly modelId: string,
    options: LlmOptions<T> = {},
  ) {
    this.options = options as Partial<LlmOptionsMerged<T>>;
  }

  public options: Partial<LlmOptionsMerged<T>>;

  mergedOptions(context: CraftContext): LlmOptionsMerged<T> {
    const store = context.getStore(ADAPTER_LLM_OPTIONS);
    return {
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
      ...store,
      ...this.options,
    } as LlmOptionsMerged<T>;
  }

  async fetch(exchange: Exchange<T>): Promise<LlmResultWithOutput<S>> {
    const context = getExchangeContext(exchange);
    const { config, modelName } = resolveModel(this.modelId, context);
    const merged = this.mergedOptions(context!);

    const system = resolvePrompt(merged.system, exchange);
    const resolvedUser = resolveUserPrompt(merged.user, exchange);
    const user =
      resolvedUser === "" ? resolveUserPromptDefault(exchange) : resolvedUser;

    const output =
      merged.output !== undefined ? toAiOutputSpec(merged.output) : undefined;

    const result = await callLlm({
      config,
      modelId: modelName,
      options: resolveSampling(merged),
      system,
      user: toPromptInput(user),
      output,
    });

    if (
      result.output === undefined &&
      result.text &&
      merged.output !== undefined
    ) {
      const fallback = await parseStructuredTextFallback(
        result.text,
        merged.output,
      );
      if (fallback !== undefined) result.output = fallback;
    }

    return result as LlmResultWithOutput<S>;
  }

  /**
   * Extract metadata from LLM result for observability.
   * Includes model, provider, and token usage.
   */
  getMetadata(result: unknown): Record<string, unknown> {
    const llmResult = result as LlmResultWithOutput<S>;
    const { providerId } = parseProviderModel(this.modelId);

    const metadata: Record<string, unknown> = {
      model: this.modelId,
      provider: providerId,
    };

    if (llmResult.usage) {
      if (llmResult.usage["inputTokens"] !== undefined) {
        metadata["inputTokens"] = llmResult.usage["inputTokens"];
      }
      if (llmResult.usage["outputTokens"] !== undefined) {
        metadata["outputTokens"] = llmResult.usage["outputTokens"];
      }
    }

    return metadata;
  }
}
