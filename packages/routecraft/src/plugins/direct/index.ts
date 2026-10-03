import { definePlugin, type Plugin } from "../../kernel/plugin.ts";
import { registerDefaultPlugin } from "../../kernel/defaults.ts";
import {
  createDirectRegistry,
  DIRECT,
} from "../../adapters/direct/registry.ts";
import type { DirectBaseOptions } from "../../adapters/direct/types.ts";

/**
 * The plugin that owns an application's direct endpoints, providing
 * {@link DIRECT}. Installed by default; the `direct` config key installs it
 * with options instead.
 *
 * @param options - The application-wide channel defaults
 */
export function directPlugin(
  options: Pick<DirectBaseOptions, "channelType"> = {},
): Plugin {
  return definePlugin({
    id: "routecraft.direct",
    provides: [DIRECT],
    bind(c) {
      c.provide(DIRECT, createDirectRegistry(options));
    },
  });
}

registerDefaultPlugin("routecraft.direct", () => directPlugin());
