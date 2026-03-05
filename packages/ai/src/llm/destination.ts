import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  getExchangeContext,
  type CraftContext,
  type Destination,
  type Exchange,
  type MergedOptions,
} from "@routecraft/routecraft";
import { callLlm } from "./providers/index.ts";
import { toAiOutputSpec } from "./structured-output.ts";
import type {
  LlmModelConfig,
  LlmOptions,
  LlmOptionsMerged,
  LlmPromptSource,
  LlmResultWithOutput,
} from "./types.ts";
import { ADAPTER_LLM_OPTIONS, ADAPTER_LLM_PROVIDERS } from "./types.ts";

/**
 * When the AI SDK doesn't set result.output (e.g. it threw on the getter), try to
 * parse result.text as JSON and validate with the output schema. Returns the
 * parsed value or undefined. Handles both sync and async Standard Schema validate().
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
  const standard = (schema as unknown as Record<string, unknown>)[
    "~standard"
  ] as
    | {
        validate: (
          value: unknown,
        ) =>
          | { value?: unknown; issues?: unknown }
          | Promise<{ value?: unknown; issues?: unknown }>;
      }
    | undefined;
  if (!standard?.validate) return undefined;
  let result = standard.validate(parsed);
  if (result instanceof Promise) result = await result;
  if (
    result &&
    typeof result === "object" &&
    "issues" in result &&
    result.issues
  )
    return undefined;
  return result && typeof result === "object" && "value" in result
    ? result.value
    : undefined;
}

const DEFAULT_TEMPERATURE = 0;
const DEFAULT_MAX_TOKENS = 1024;

function resolvePrompt(
  source: LlmPromptSource | undefined,
  exchange: Exchange<unknown>,
): string {
  if (source === undefined || source === "") return "";
  if (typeof source === "function") return source(exchange);
  return source;
}

function resolveUserPromptDefault(exchange: Exchange<unknown>): string {
  const body = exchange.body;
  if (typeof body === "string") return body;
  if (body === null || body === undefined) return "";
  if (typeof body === "object") return JSON.stringify(body);
  return String(body);
}

/** Format: "providerId:modelName", e.g. "ollama:lfm2.5-thinking". */
function parseProviderModel(id: string): {
  providerId: string;
  modelName: string;
} {
  const colon = id.indexOf(":");
  if (colon < 1 || colon === id.length - 1) {
    throw new Error(
      `LLM adapter: model id must be "providerId:modelName" (e.g. ollama:lfm2.5-thinking). Got: "${id}"`,
    );
  }
  return {
    providerId: id.slice(0, colon),
    modelName: id.slice(colon + 1),
  };
}

function resolveProviderAndModel(
  modelId: string,
  context: CraftContext | undefined,
): { config: LlmModelConfig; modelName: string } {
  if (!context) {
    throw new Error(
      `LLM adapter: model id "${modelId}" requires a context to resolve. Ensure the exchange has context (e.g. from a route) so store "${ADAPTER_LLM_PROVIDERS.description}" can be read.`,
    );
  }
  const store = context.getStore(
    ADAPTER_LLM_PROVIDERS as keyof import("@routecraft/routecraft").StoreRegistry,
  ) as Map<string, LlmModelConfig> | undefined;
  if (!store) {
    throw new Error(
      `LLM provider not found: no providers registered. Add llmPlugin({ providers: { ollama: { provider: "ollama" }, ... } }) to your config.`,
    );
  }
  const { providerId, modelName } = parseProviderModel(modelId);
  const config = store.get(providerId);
  if (!config) {
    throw new Error(
      `LLM provider "${providerId}" not found. Register it with llmPlugin({ providers: { "${providerId}": { provider, apiKey?, baseURL? } } }).`,
    );
  }
  return { config, modelName };
}

/**
 * LLM destination adapter. Expects model id as "providerId:modelName" (e.g. ollama:lfm2.5-thinking),
 * resolves the provider from the plugin store, merges options, and calls the provider with the model name.
 * Use with .enrich(llm("providerId:modelName", options)) or .to(llm(...)).
 *
 * @template S - Output schema type when outputSchema is provided; narrows result.output for downstream typing.
 */
export class LlmDestinationAdapter<
  S extends StandardSchemaV1 | undefined = undefined,
>
  implements
    Destination<unknown, LlmResultWithOutput<S>>,
    MergedOptions<LlmOptionsMerged>
{
  readonly adapterId = "routecraft.adapter.llm";

  constructor(
    private readonly modelId: string,
    options: Partial<LlmOptions> = {},
  ) {
    this.options = options as Partial<LlmOptionsMerged>;
  }

  public options: Partial<LlmOptionsMerged>;

  mergedOptions(context: CraftContext): LlmOptionsMerged {
    const store = context.getStore(
      ADAPTER_LLM_OPTIONS as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as Partial<LlmOptionsMerged> | undefined;
    return {
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
      ...store,
      ...this.options,
    } as LlmOptionsMerged;
  }

  async send(exchange: Exchange<unknown>): Promise<LlmResultWithOutput<S>> {
    const context = getExchangeContext(exchange);
    const { config, modelName } = resolveProviderAndModel(
      this.modelId,
      context,
    );
    const merged = this.mergedOptions(context!);

    const systemPrompt = resolvePrompt(merged.systemPrompt, exchange);
    const userPrompt =
      resolvePrompt(merged.userPrompt, exchange) ||
      resolveUserPromptDefault(exchange);

    const opts: Parameters<typeof callLlm>[0]["options"] = {
      temperature: merged.temperature,
      maxTokens: merged.maxTokens,
    };
    if (merged.topP !== undefined) opts.topP = merged.topP;
    if (merged.frequencyPenalty !== undefined)
      opts.frequencyPenalty = merged.frequencyPenalty;
    if (merged.presencePenalty !== undefined)
      opts.presencePenalty = merged.presencePenalty;

    const output =
      merged.outputSchema !== undefined
        ? toAiOutputSpec(merged.outputSchema)
        : undefined;

    const result = await callLlm({
      config,
      modelId: modelName,
      options: opts,
      systemPrompt,
      userPrompt,
      output,
    });

    if (
      result.output === undefined &&
      result.text &&
      merged.outputSchema !== undefined
    ) {
      const fallback = await parseStructuredTextFallback(
        result.text,
        merged.outputSchema,
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
