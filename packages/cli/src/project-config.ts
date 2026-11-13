import type { CraftConfig } from "@routecraft/routecraft";
import { displayPath, findConfigFile } from "./project.js";
import { messageOf } from "./util.js";

export { displayPath };

/**
 * The configuration of the project in the current directory, for a
 * command that acts on what the project declares rather than running it:
 * the config file and the folder plugins, as `craft start` loads them.
 * The agents and skills `craft start` discovers from folders are left
 * out, since they declare no client and no credential.
 *
 * @param command - The command, for the message (`"craft connect"`)
 * @param reads - What the command reads from the config, for the message
 * @throws when the directory has no config file, or the file fails to load
 */
export async function loadProjectConfig(
  command: string,
  reads: string,
): Promise<{ root: string; configPath: string; config: CraftConfig }> {
  const root = process.cwd();
  const configPath = findConfigFile(root);
  if (configPath === undefined) {
    throw new Error(
      `No craft.config.ts found in "${root}". ${command} reads ${reads} from it.`,
    );
  }
  const { loadConfig, projectContentRoot, withFolderPlugins } =
    await import("./start.js");
  try {
    const config = await withFolderPlugins(
      root,
      projectContentRoot(root),
      await loadConfig(configPath),
    );
    return { root, configPath, config };
  } catch (error: unknown) {
    throw new Error(
      `Failed to load ${displayPath(root, configPath)}: ${messageOf(error)}`,
      { cause: error },
    );
  }
}
