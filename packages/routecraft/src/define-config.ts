// Self-reference via the published specifier so ecosystem augmentations
// (`declare module "@routecraft/routecraft" { interface CraftConfig { ... } }`)
// propagate into this module's view of `CraftConfig`. Importing through
// `./context.ts` would resolve to a separate module identity and miss the
// augmentations. See config-applier.ts for the same pattern.
import type { CraftConfig } from "@routecraft/routecraft";

/**
 * Identity helper for typing a {@link CraftConfig}. Returns the input
 * unchanged at runtime; at compile time it gives the literal the same
 * checking a `const config: CraftConfig = {...}` annotation does: autocomplete
 * for every key (including keys augmented by ecosystem packages such as
 * `@routecraft/ai`) and an error for any key `CraftConfig` does not declare,
 * at every nesting level.
 *
 * The parameter is deliberately not generic. TypeScript checks excess
 * properties only against a concrete target type, so a `<T extends
 * CraftConfig>` parameter let a stale or misspelled key compile and fail at
 * boot instead.
 *
 * @param config - Config object
 * @returns The same config object
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@routecraft/routecraft";
 * import "@routecraft/ai"; // augments CraftConfig with `llm`, `mcp`, etc.
 *
 * export const craftConfig = defineConfig({
 *   cron: { timezone: "UTC" },
 *   llm: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } },
 * });
 * ```
 */
export function defineConfig(config: CraftConfig): CraftConfig {
  return config;
}
