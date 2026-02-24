import type { EmbeddingModelConfig } from "../types.ts";

export interface CallEmbeddingParams {
  config: EmbeddingModelConfig;
  modelName: string;
  text: string;
}

type PipelineFn = (
  text: string,
  options?: { pooling?: string; normalize?: boolean },
) => Promise<unknown>;

interface CachedPipeline {
  run: PipelineFn;
  dispose?: (() => Promise<void>) | undefined;
}

const pipelineCache = new Map<string, CachedPipeline>();

/**
 * Dispose all cached HuggingFace pipelines and clear the cache. Call on context
 * shutdown so pipeline.dispose() releases native/ONNX resources.
 *
 * Callers must avoid process.exit() after this — let the event loop drain
 * naturally so ONNX Runtime's C++ statics aren't torn down prematurely
 * (onnxruntime#25038: "mutex lock failed: Invalid argument").
 */
export async function disposeEmbeddingPipelineCache(): Promise<void> {
  const entries = [...pipelineCache.entries()];
  pipelineCache.clear();
  if (entries.length === 0) return;

  await Promise.all(
    entries.map(async ([, cached]) => {
      try {
        if (typeof cached.dispose === "function") {
          await cached.dispose();
        }
      } catch {
        // Ignore dispose errors during shutdown
      }
    }),
  );
}

/** Resolve to full Hugging Face repo id. Short names like "all-MiniLM-L6-v2" use Xenova/ (ONNX-converted). */
function resolveHuggingFaceModel(modelName: string): string {
  if (modelName.includes("/")) return modelName;
  return `Xenova/${modelName}`;
}

async function getHuggingFacePipeline(modelName: string): Promise<PipelineFn> {
  const resolved = resolveHuggingFaceModel(modelName);
  const cached = pipelineCache.get(resolved);
  if (cached) return cached.run;

  const { pipeline } = await import("@huggingface/transformers");
  const pipe = await pipeline("feature-extraction", resolved, {
    dtype: "fp32",
  });
  const run: PipelineFn = (text, options) =>
    pipe(text, {
      pooling: (options?.pooling ?? "mean") as "mean",
      normalize: options?.normalize ?? true,
    });
  const entry: CachedPipeline = {
    run,
    dispose:
      typeof pipe.dispose === "function"
        ? () => Promise.resolve(pipe.dispose())
        : undefined,
  };
  pipelineCache.set(resolved, entry);
  return run;
}

function toNumberArray(data: Float32Array | number[] | unknown): number[] {
  if (Array.isArray(data)) return data as number[];
  if (data instanceof Float32Array) return Array.from(data);
  if (data && typeof data === "object" && "data" in data) {
    const d = (data as { data: Float32Array | number[] }).data;
    return Array.isArray(d) ? d : Array.from(d);
  }
  return [];
}

export async function callEmbedding(
  params: CallEmbeddingParams,
): Promise<number[]> {
  const { config, modelName, text } = params;
  if (config.provider === "mock") {
    const dim = 8;
    const vec: number[] = [];
    for (let i = 0; i < dim; i++) {
      vec.push(((text.length + i) % 100) / 100);
    }
    return vec;
  }
  if (config.provider === "huggingface") {
    const pipe = await getHuggingFacePipeline(modelName);
    const output = await pipe(text, {
      pooling: "mean" as const,
      normalize: true,
    });
    const data =
      output && typeof output === "object" && "data" in output
        ? (output as { data: Float32Array | number[] }).data
        : output;
    return toNumberArray(data);
  }
  if (config.provider === "ollama" || config.provider === "openai") {
    throw new Error(
      `Embedding provider "${config.provider}" is not yet implemented. Use huggingface for now.`,
    );
  }
  throw new Error(
    `Unknown embedding provider: ${(config as EmbeddingModelConfig).provider}`,
  );
}
