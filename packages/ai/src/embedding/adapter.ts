import {
  getExchangeContext,
  type CraftContext,
  type Destination,
  type Exchange,
  type MergedOptions,
} from "@routecraft/routecraft";
import { callEmbedding } from "./providers/index.ts";
import type {
  EmbeddingModelConfig,
  EmbeddingOptions,
  EmbeddingOptionsMerged,
  EmbeddingResult,
} from "./types.ts";
import {
  ADAPTER_EMBEDDING_OPTIONS,
  ADAPTER_EMBEDDING_PROVIDERS,
} from "./types.ts";

function parseProviderModel(id: string): {
  providerId: string;
  modelName: string;
} {
  const colon = id.indexOf(":");
  if (colon < 1 || colon === id.length - 1) {
    throw new Error(
      `Embedding adapter: model id must be "providerId:modelName" (e.g. huggingface:all-MiniLM-L6-v2). Got: "${id}"`,
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
): { config: EmbeddingModelConfig; modelName: string } {
  if (!context) {
    throw new Error(
      `Embedding adapter: model id "${modelId}" requires a context to resolve. Ensure the exchange has context (e.g. from a route) so embedding providers can be read.`,
    );
  }
  const store = context.getStore(
    ADAPTER_EMBEDDING_PROVIDERS as keyof import("@routecraft/routecraft").StoreRegistry,
  ) as Map<string, EmbeddingModelConfig> | undefined;
  if (!store) {
    throw new Error(
      "Embedding provider not found: no providers registered. Add embeddingPlugin({ providers: { huggingface: {} } }) to your config.",
    );
  }
  const { providerId, modelName } = parseProviderModel(modelId);
  const config = store.get(providerId);
  if (!config) {
    throw new Error(
      `Embedding provider "${providerId}" not found. Register it with embeddingPlugin({ providers: { "${providerId}": {} } }).`,
    );
  }
  return { config, modelName };
}

function buildText<T>(
  using: (exchange: Exchange<T>) => string | string[],
): (exchange: Exchange<T>) => string {
  return (exchange: Exchange<T>) => {
    const value = using(exchange);
    return Array.isArray(value) ? value.filter(Boolean).join(" | ") : value;
  };
}

/**
 * Embedding destination adapter. Expects model id as "providerId:modelName"
 * (e.g. huggingface:all-MiniLM-L6-v2), resolves the provider from the plugin store,
 * and returns { embedding: number[] }. Use with .enrich(embedding("provider:model", { using: ... })).
 */
export class EmbeddingAdapter<T = unknown>
  implements
    Destination<T, EmbeddingResult>,
    MergedOptions<EmbeddingOptionsMerged>
{
  readonly adapterId = "routecraft.adapter.embedding";

  constructor(
    private readonly modelId: string,
    options: Partial<EmbeddingOptions<T>> = {},
  ) {
    this.options = options as Partial<EmbeddingOptionsMerged>;
  }

  public options: Partial<EmbeddingOptionsMerged>;

  mergedOptions(context: CraftContext): EmbeddingOptionsMerged {
    const store = context.getStore(
      ADAPTER_EMBEDDING_OPTIONS as keyof import("@routecraft/routecraft").StoreRegistry,
    ) as Partial<EmbeddingOptionsMerged> | undefined;
    return { ...store, ...this.options } as EmbeddingOptionsMerged;
  }

  async send(exchange: Exchange<T>): Promise<EmbeddingResult> {
    const context = getExchangeContext(exchange);
    const { config, modelName } = resolveProviderAndModel(
      this.modelId,
      context,
    );
    const merged = this.mergedOptions(context!);

    if (!merged.using) {
      throw new Error(
        "Embedding adapter: options.using(exchange) is required to build the string to embed.",
      );
    }

    const getText = buildText(
      merged.using as (e: Exchange<unknown>) => string | string[],
    );
    const text = getText(exchange as Exchange<unknown>);

    const embedding = await callEmbedding({ config, modelName, text });
    return { embedding };
  }
}
