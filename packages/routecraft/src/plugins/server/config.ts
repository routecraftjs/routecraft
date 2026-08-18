import { registerConfigApplier } from "../../config-applier.ts";
import { serversPlugin } from "./plugin.ts";
import type { ServerDefinitions } from "./types.ts";

declare module "@routecraft/routecraft" {
  interface CraftConfig {
    servers?: ServerDefinitions;
  }
}

registerConfigApplier("servers", (definitions) => serversPlugin(definitions));
