import type { CredentialStore } from "@routecraft/routecraft";
import type { ExecResult } from "./exec.js";
import { displayPath, loadProjectConfig } from "./project-config.js";
import { messageOf } from "./util.js";

/**
 * Run a command an ecosystem package registered for the project, such as
 * `craft mcp pin` from `@routecraft/ai`. The package owns what the command
 * does and prints; this loads the project, hands it over, and closes the
 * credential store if the command opened it.
 */
export async function runProjectCommand(
  name: string,
  args: readonly string[],
): Promise<ExecResult> {
  let opened: { store: CredentialStore; owned: boolean } | undefined;
  try {
    const { root, configPath, config } = await loadProjectConfig(
      `craft ${name}`,
      "the clients it acts on",
    );
    const core = await import("@routecraft/routecraft");
    const command = core.projectCommand(name);
    if (command === undefined) {
      return {
        code: 1,
        error: `craft ${name} is provided by a package ${displayPath(root, configPath)} does not load. For an MCP command, import @routecraft/ai for its side effects:\n\n  import "@routecraft/ai";`,
      };
    }
    return await command(config, {
      args,
      root,
      credentials: async () => {
        opened ??= await core.openCredentialStore(
          core.credentialsConfigOf(config),
        );
        return opened.store;
      },
    });
  } catch (error: unknown) {
    return { code: 1, error: messageOf(error) };
  } finally {
    if (opened?.owned) await opened.store.close();
  }
}
