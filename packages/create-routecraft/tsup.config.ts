import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
import { workspaceVersions } from "./src/versions.ts";

/**
 * The build runs after the release flow has versioned every package, stable
 * and canary alike, so the map it bakes in names releases that exist.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  define: {
    __ROUTECRAFT_VERSIONS__: JSON.stringify(
      workspaceVersions(fileURLToPath(new URL("..", import.meta.url))),
    ),
  },
});
