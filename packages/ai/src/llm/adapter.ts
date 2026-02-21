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
  LlmResult,
} from "./types.ts";
import { ADAPTER_LLM_OPTIONS, ADAPTER_LLM_PROVIDERS } from "./types.ts";

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
 */
export class LlmAdapter
  implements Destination<unknown, LlmResult>, MergedOptions<LlmOptionsMerged>
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

  async send(exchange: Exchange<unknown>): Promise<LlmResult> {
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

    return callLlm({
      config,
      modelId: modelName,
      options: opts,
      systemPrompt,
      userPrompt,
      output,
    });
  }
}
