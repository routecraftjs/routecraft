import type { Enricher, Exchange } from "@routecraft/routecraft";
import { callEmbedding } from "./providers/index.ts";
import type {
  EmbeddingModelConfig,
  EmbeddingOptions,
  EmbeddingResult,
  EmbeddingService,
} from "./types.ts";
import { embeddingServices } from "./types.ts";

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
  service: EmbeddingService | undefined,
): { config: EmbeddingModelConfig; modelName: string } {
  const store = service?.providers;
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
export class EmbeddingEnricherAdapter<T = unknown> implements Enricher<
  T,
  EmbeddingResult
> {
  readonly adapterId = "routecraft.adapter.embedding";

  constructor(
    private readonly modelId: string,
    options: EmbeddingOptions<T>,
  ) {
    this.options = options as Partial<EmbeddingOptions>;
  }

  public options: Partial<EmbeddingOptions>;

  async fetch(exchange: Exchange<T>): Promise<EmbeddingResult> {
    const service = embeddingServices.of(exchange);
    const { config, modelName } = resolveProviderAndModel(
      this.modelId,
      service,
    );
    const merged = {
      ...service?.defaults,
      ...this.options,
    } as EmbeddingOptions;

    const getText = buildText(
      merged.using as (e: Exchange<unknown>) => string | string[],
    );
    const text = getText(exchange as Exchange<unknown>);

    const embedding = await callEmbedding({ config, modelName, text });
    return { embedding };
  }
}
