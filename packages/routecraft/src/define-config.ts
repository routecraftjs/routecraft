// Self-reference via the published specifier so ecosystem augmentations
// (`declare module "@routecraft/routecraft" { interface CraftConfig { ... } }`)
// propagate into this module's view of `CraftConfig`. Importing through
// `./context.ts` would resolve to a separate module identity and miss the
// augmentations. See config-applier.ts for the same pattern.
import type { CraftConfig } from "@routecraft/routecraft";

/**
 * Identity helper for typing a {@link CraftConfig}. Returns the input
 * unchanged at runtime; the generic parameter preserves the literal type at
 * the call site so users get autocomplete for first-class keys (including
 * keys augmented by ecosystem packages such as `@routecraft/ai`).
 *
 * @template T - Inferred config shape
 * @param config - Config object
 * @returns The same config object
 *
 * @experimental
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@routecraft/routecraft";
 * import "@routecraft/ai"; // augments CraftConfig with `llm`, `mcp`, etc.
 *
 * export default defineConfig({
 *   cron: { timezone: "UTC" },
 *   llm: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } },
 * });
 * ```
 */
export function defineConfig<T extends CraftConfig>(config: T): T {
  return config;
}
