import { createHash } from "node:crypto";
import { loadOptionalPeer } from "@routecraft/routecraft";
import { assertLanguageModelShape, PROVIDER_DEFAULTS } from "./llm-utils.ts";
import type { LlmModelConfig } from "../types.ts";

/**
 * Resolve the AI SDK `LanguageModel` for a given provider config.
 * Single source of truth used by both the synchronous and streaming
 * dispatch paths so provider setup is not duplicated per dispatch mode.
 *
 * Provider SDKs are optional peer dependencies, loaded lazily through
 * `loadOptionalPeer` so a missing package surfaces as `RC5017` with an
 * install hint (see `.standards/ci-cd.md` § 6).
 */
export async function resolveLanguageModel(
  config: LlmModelConfig,
  modelId: string,
): Promise<unknown> {
  switch (config.provider) {
    case "openai":
      return resolveOpenAI(config, modelId);
    case "anthropic":
      return resolveAnthropic(config, modelId);
    case "gemini":
      return resolveGemini(config, modelId);
    case "openrouter":
      return resolveOpenRouter(config, modelId);
    case "ollama":
      return resolveOllama(config, modelId);
    case "lmstudio":
      return resolveLmStudio(config, modelId);
    case "copilot":
      return resolveCopilot(config, modelId);
    case "custom":
      return resolveCustom(config, modelId);
    default: {
      const _: never = config;
      throw new Error(
        `LLM provider not implemented: ${(_ as LlmModelConfig).provider}`,
      );
    }
  }
}

/**
 * Settings shared by the keyed cloud providers (OpenAI, Anthropic, Gemini):
 * a required API key plus an optional API URL override.
 */
interface KeyedProviderSettings {
  apiKey: string;
  baseURL?: string;
}

/**
 * Build the SDK factory settings for a keyed provider. `baseURL` is omitted
 * entirely when unset (rather than passed as `undefined`) so the settings
 * object mirrors the user's config and the SDK's own default and env-var
 * resolution applies untouched.
 */
function keyedSettings(config: KeyedProviderSettings): KeyedProviderSettings {
  const settings: KeyedProviderSettings = { apiKey: config.apiKey };
  if (config.baseURL !== undefined) settings.baseURL = config.baseURL;
  return settings;
}

async function resolveOpenAI(
  config: import("../types.ts").LlmModelConfigOpenAI,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(() => import("@ai-sdk/openai"), {
    adapterName: "OpenAI LLM",
    packageName: "@ai-sdk/openai",
  })) as {
    createOpenAI: (s: KeyedProviderSettings) => (m: string) => unknown;
  };
  const openai = mod.createOpenAI(keyedSettings(config));
  return openai(modelId);
}

async function resolveAnthropic(
  config: import("../types.ts").LlmModelConfigAnthropic,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(() => import("@ai-sdk/anthropic"), {
    adapterName: "Anthropic LLM",
    packageName: "@ai-sdk/anthropic",
  })) as {
    createAnthropic: (s: KeyedProviderSettings) => (m: string) => unknown;
  };
  const anthropic = mod.createAnthropic(keyedSettings(config));
  return anthropic(modelId);
}

async function resolveGemini(
  config: import("../types.ts").LlmModelConfigGemini,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(() => import("@ai-sdk/google"), {
    adapterName: "Gemini LLM",
    packageName: "@ai-sdk/google",
  })) as {
    createGoogleGenerativeAI: (
      s: KeyedProviderSettings,
    ) => (m: string) => unknown;
  };
  const google = mod.createGoogleGenerativeAI(keyedSettings(config));
  return google(modelId);
}

async function resolveOpenRouter(
  config: import("../types.ts").LlmModelConfigOpenRouter,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(
    () => import("@openrouter/ai-sdk-provider"),
    {
      adapterName: "OpenRouter LLM",
      packageName: "@openrouter/ai-sdk-provider",
    },
  )) as {
    createOpenRouter: (s: { apiKey: string }) => {
      chat: (id: string) => unknown;
    };
  };
  const openrouter = mod.createOpenRouter({ apiKey: config.apiKey });
  const resolvedId = config.modelId ?? modelId;
  const rawModel = openrouter.chat(resolvedId);
  assertLanguageModelShape(rawModel, "OpenRouter", resolvedId);
  return rawModel;
}

async function resolveOllama(
  config: import("../types.ts").LlmModelConfigOllama,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(() => import("ollama-ai-provider-v2"), {
    adapterName: "Ollama LLM",
    packageName: "ollama-ai-provider-v2",
  })) as {
    createOllama: (s: { baseURL?: string }) => (name: string) => unknown;
  };
  const ollama = mod.createOllama({
    baseURL: config.baseURL ?? PROVIDER_DEFAULTS.ollama.baseURL,
  });
  const name = config.modelId ?? modelId;
  const rawModel = ollama(name);
  assertLanguageModelShape(rawModel, "Ollama", name);
  return rawModel;
}

async function resolveLmStudio(
  config: import("../types.ts").LlmModelConfigLmStudio,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(
    () => import("@ai-sdk/openai-compatible"),
    { adapterName: "LM Studio LLM", packageName: "@ai-sdk/openai-compatible" },
  )) as {
    createOpenAICompatible: (s: {
      name: string;
      baseURL: string;
      apiKey?: string;
      includeUsage?: boolean;
    }) => (id: string) => unknown;
  };
  // LM Studio serves an OpenAI-compatible chat-completions API. We use Vercel's
  // dedicated openai-compatible provider (not @ai-sdk/openai) so the adapter is
  // not tied to OpenAI-specific behaviour such as the Responses API. The
  // provider's default model is the chat-completions model, and `includeUsage`
  // makes LM Studio report token usage on streaming responses too.
  const settings: {
    name: string;
    baseURL: string;
    apiKey?: string;
    includeUsage: boolean;
  } = {
    name: "lmstudio",
    baseURL: config.baseURL ?? PROVIDER_DEFAULTS.lmstudio.baseURL,
    includeUsage: true,
  };
  // Only send an Authorization header when a key is configured; LM Studio
  // ignores auth, so we do not invent a placeholder bearer token.
  if (config.apiKey !== undefined) settings.apiKey = config.apiKey;
  const lmstudio = mod.createOpenAICompatible(settings);
  const name = config.modelId ?? modelId;
  const rawModel = lmstudio(name);
  assertLanguageModelShape(rawModel, "LM Studio", name);
  return rawModel;
}

type CopilotProviderFactory = ((
  id: string,
  settings?: Record<string, unknown>,
) => unknown) & {
  getClient?: () => { stop?: () => Promise<unknown> };
};

/**
 * One provider (and therefore one `CopilotClient`, which owns a spawned
 * `copilot` CLI server process) per distinct client config. `resolveCopilot`
 * runs on every dispatch, so without this cache each `llm()` call would
 * spawn and leak a fresh CLI process.
 *
 * Keyed by a hash of the client options rather than the options themselves:
 * they can carry a `githubToken`, and `.standards/security.md` section 4
 * forbids holding a plaintext bearer as a map key.
 */
const copilotProviderCache = new Map<string, CopilotProviderFactory>();

/**
 * Number of applied `llmPlugin` instances that have not yet torn down. The
 * Copilot client cache is process-wide, so concurrent contexts sharing a
 * client config share its CLI process; disposing on the first teardown would
 * stop a client another context is still using.
 * @internal
 */
let copilotClientHolders = 0;

/**
 * Stop every cached Copilot client and clear the cache. Each client owns a
 * spawned `copilot` CLI process that is not unref'd, so without this the
 * process outlives context shutdown and keeps the runtime alive.
 *
 * The cache is process-wide, so this stops clients belonging to every context
 * in the process. `llmPlugin` therefore does not call it directly: it goes
 * through `releaseCopilotClients`, which only disposes once the last context
 * has torn down. Call this directly when registering providers without the
 * plugin, or to force disposal.
 *
 * This drops all Copilot client state, holders included, so what remains is
 * what a fresh process would have. A holder that releases afterwards finds
 * the count already at zero and disposes an empty cache, which is harmless.
 */
export async function disposeCopilotProviderCache(): Promise<void> {
  const providers = [...copilotProviderCache.values()];
  copilotProviderCache.clear();
  copilotClientHolders = 0;
  await Promise.all(
    providers.map(async (provider) => {
      try {
        await provider.getClient?.().stop?.();
      } catch {
        // Ignore stop errors during shutdown.
      }
    }),
  );
}

/**
 * Register a holder of the Copilot client cache. Paired with
 * `releaseCopilotClients`.
 * @internal
 */
export function retainCopilotClients(): void {
  copilotClientHolders += 1;
}

/**
 * Release a holder and dispose the cache once none remain, so the CLI
 * process outlives every context that might still dispatch to it and no
 * longer.
 * @internal
 */
export async function releaseCopilotClients(): Promise<void> {
  copilotClientHolders = Math.max(0, copilotClientHolders - 1);
  if (copilotClientHolders === 0) await disposeCopilotProviderCache();
}

async function resolveCopilot(
  config: import("../types.ts").LlmModelConfigCopilot,
  modelId: string,
): Promise<unknown> {
  const mod = (await loadOptionalPeer(
    () => import("@nomomon/ai-sdk-provider-github-copilot"),
    {
      adapterName: "GitHub Copilot LLM",
      packageName: "@nomomon/ai-sdk-provider-github-copilot",
    },
  )) as {
    createGitHubCopilot: (options?: {
      clientOptions?: Record<string, unknown>;
    }) => CopilotProviderFactory;
  };
  // cliPath/cliUrl/githubToken configure the CopilotClient, not the model:
  // the provider's default export ignores the same-named settings fields, so
  // they must go through createGitHubCopilot({ clientOptions }).
  const clientOptions: Record<string, unknown> = {};
  if (config.cliPath !== undefined) clientOptions["cliPath"] = config.cliPath;
  if (config.cliUrl !== undefined) clientOptions["cliUrl"] = config.cliUrl;
  if (config.githubToken !== undefined) {
    clientOptions["githubToken"] = config.githubToken;
  }
  // Hash rather than store: clientOptions can hold a githubToken, and a
  // plaintext bearer must never sit in a long-lived map key
  // (.standards/security.md section 4).
  const cacheKey = createHash("sha256")
    .update(JSON.stringify(clientOptions))
    .digest("hex");
  let provider = copilotProviderCache.get(cacheKey);
  if (!provider) {
    provider = mod.createGitHubCopilot(
      Object.keys(clientOptions).length > 0 ? { clientOptions } : {},
    );
    copilotProviderCache.set(cacheKey, provider);
  }
  const name = config.modelId ?? modelId;
  // Forward a permission handler only when the caller asked for one. With no
  // handler registered the Copilot SDK denies each request that needs
  // approval, so doing nothing here is the fail-closed default; approving
  // everything is an explicit opt-in via approveAllTools.
  const settings: Record<string, unknown> = {};
  if (config.onPermissionRequest !== undefined) {
    settings["onPermissionRequest"] = config.onPermissionRequest;
  } else if (config.approveAllTools === true) {
    settings["onPermissionRequest"] = () => ({ kind: "approved" });
  }
  if (config.workingDirectory !== undefined) {
    settings["workingDirectory"] = config.workingDirectory;
  }
  const rawModel = provider(name, settings);
  assertLanguageModelShape(rawModel, "GitHub Copilot", name);
  return rawModel;
}

function resolveCustom(
  config: import("../types.ts").LlmModelConfigCustom,
  modelId: string,
): unknown {
  const { model } = config;
  const resolved =
    typeof model === "function"
      ? (model as (id: string) => unknown)(modelId)
      : model;
  assertLanguageModelShape(resolved, "Custom", modelId || "(custom)");
  return resolved;
}
