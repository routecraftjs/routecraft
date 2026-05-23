import type { CraftContext, CraftPlugin } from "@routecraft/routecraft";
import { disposeEmbeddingPipelineCache } from "./providers/index.ts";
import {
  ADAPTER_EMBEDDING_OPTIONS,
  ADAPTER_EMBEDDING_PROVIDERS,
} from "./types.ts";
import type { EmbeddingModelConfig, EmbeddingPluginOptions } from "./types.ts";

/** Normalize provider options to full EmbeddingModelConfig (providerId wins over opts.provider). */
function toModelConfig(
  providerId: string,
  opts: Record<string, unknown>,
): EmbeddingModelConfig {
  return {
    ...opts,
    provider: providerId as EmbeddingModelConfig["provider"],
  } as EmbeddingModelConfig;
}

/**
 * Embedding plugin: registers providers and teardown to clear the pipeline
 * cache when the context stops (releases native/ONNX resources).
 * Use embedding("providerId:modelName", { using: ... }),
 * e.g. embedding("huggingface:all-MiniLM-L6-v2", { using: (e) => e.body.title }).
 */
export function embeddingPlugin(
  options: EmbeddingPluginOptions = { providers: {} },
): CraftPlugin {
  return {
    apply(ctx: CraftContext) {
      const map = new Map<string, EmbeddingModelConfig>();
      for (const [providerId, opts] of Object.entries(options.providers)) {
        if (opts !== undefined) {
          map.set(
            providerId,
            toModelConfig(providerId, opts as Record<string, unknown>),
          );
        }
      }
      ctx.setStore(
        ADAPTER_EMBEDDING_PROVIDERS as keyof import("@routecraft/routecraft").StoreRegistry,
        map,
      );
      if (
        options.defaultOptions &&
        Object.keys(options.defaultOptions).length > 0
      ) {
        ctx.setStore(
          ADAPTER_EMBEDDING_OPTIONS as keyof import("@routecraft/routecraft").StoreRegistry,
          options.defaultOptions,
        );
      }
    },
    async teardown() {
      await disposeEmbeddingPipelineCache();
    },
  };
}
