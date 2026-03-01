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

const HUGGINGFACE_INSTALL =
  'The Hugging Face embedding provider requires "@huggingface/transformers". Install it with: pnpm add @huggingface/transformers';

function isModuleNotFoundFor(error: unknown, pkg: string): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message ?? "";
  return (
    (msg.includes("ERR_MODULE_NOT_FOUND") ||
      msg.includes("Cannot find module") ||
      msg.includes("Cannot find package")) &&
    msg.includes(pkg)
  );
}

async function getHuggingFacePipeline(modelName: string): Promise<PipelineFn> {
  const resolved = resolveHuggingFaceModel(modelName);
  const cached = pipelineCache.get(resolved);
  if (cached) return cached.run;

  let pipelineFn: (
    task: string,
    model: string,
    opts?: { dtype?: string },
  ) => Promise<unknown>;
  try {
    const mod = await import("@huggingface/transformers");
    pipelineFn = mod.pipeline as typeof pipelineFn;
  } catch (error) {
    if (isModuleNotFoundFor(error, "@huggingface/transformers")) {
      throw new Error(HUGGINGFACE_INSTALL);
    }
    throw error;
  }
  const pipe = (await pipelineFn("feature-extraction", resolved, {
    dtype: "fp32",
  })) as {
    (
      text: string,
      options?: { pooling?: string; normalize?: boolean },
    ): Promise<unknown>;
    dispose?: () => void;
  };
  const run: PipelineFn = (text, options) =>
    pipe(text, {
      pooling: (options?.pooling ?? "mean") as "mean",
      normalize: options?.normalize ?? true,
    });
  const entry: CachedPipeline = {
    run,
    dispose:
      typeof pipe.dispose === "function"
        ? () => Promise.resolve(pipe.dispose!())
        : undefined,
  };
  pipelineCache.set(resolved, entry);
  return run;
}

function previewForError(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  try {
    const s = JSON.stringify(value);
    return s.length > 100 ? s.slice(0, 100) + "..." : s;
  } catch {
    return "object";
  }
}

function toNumberArray(data: Float32Array | number[] | unknown): number[] {
  if (Array.isArray(data)) return data as number[];
  if (data instanceof Float32Array) return Array.from(data);
  if (data && typeof data === "object" && "data" in data) {
    const d = (data as { data: unknown }).data;
    if (Array.isArray(d)) return d as number[];
    if (d instanceof Float32Array) return Array.from(d);
    throw new Error(
      `Embedding output .data must be an Array or Float32Array; got ${typeof d}: ${previewForError(d)}`,
    );
  }
  throw new Error(
    `Embedding output must be an Array, Float32Array, or object with .data; got ${typeof data}: ${previewForError(data)}`,
  );
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
