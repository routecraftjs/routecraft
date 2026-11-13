import type { CraftConfig, CredentialStore } from "@routecraft/routecraft";
import type { ExecResult } from "./exec.js";
import { displayPath, findConfigFile } from "./project.js";
import { messageOf } from "./util.js";

/**
 * The pin command `@routecraft/ai` registers when it is imported, mirrored
 * here because the CLI does not depend on that package.
 */
type PinMcpClients = (
  config: CraftConfig,
  request: {
    client?: string | undefined;
    credentials: () => Promise<CredentialStore>;
  },
) => Promise<{
  path: string;
  written: boolean;
  clients: ReadonlyArray<{
    id: string;
    added: ReadonlyArray<{ name: string; class: string }>;
    changed: readonly string[];
    removed: readonly string[];
    unchanged: number;
  }>;
  failed: ReadonlyArray<{ id: string; reason: string }>;
}>;

const PIN_COMMAND = Symbol.for("routecraft.mcp.pin");

/**
 * A name a remote server chose, made safe to print: anything outside
 * printable ASCII becomes a `\u` escape, so a tool name cannot move the
 * cursor or hide part of the line a reviewer reads.
 */
function printable(name: string): string {
  return name.replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Write what the configured MCP clients list now to the lockfile.
 *
 * - `craft mcp pin` lists every client that sets `pins`.
 * - `craft mcp pin <client>` lists that one, pinned or not.
 *
 * The lockfile is approved by committing it, so the output names what
 * changed and leaves the review to the diff.
 */
export async function mcpPinCommand(
  client: string | undefined,
): Promise<ExecResult> {
  const root = process.cwd();
  const configPath = findConfigFile(root);
  if (configPath === undefined) {
    return {
      code: 1,
      error: `No craft.config.ts found in "${root}". craft mcp pin reads the clients to pin from it.`,
    };
  }
  let opened: { store: CredentialStore; owned: boolean } | undefined;
  try {
    const { loadConfig, projectContentRoot, withFolderPlugins } =
      await import("./start.js");
    let config: CraftConfig;
    try {
      config = await loadConfig(configPath);
      config = await withFolderPlugins(root, projectContentRoot(root), config);
    } catch (error: unknown) {
      return {
        code: 1,
        error: `Failed to load ${displayPath(root, configPath)}: ${messageOf(error)}`,
      };
    }
    const pin = (globalThis as Record<symbol, unknown>)[PIN_COMMAND] as
      PinMcpClients | undefined;
    if (pin === undefined) {
      return {
        code: 1,
        error: `craft mcp pin needs @routecraft/ai. Import it for its side effects from ${displayPath(root, configPath)}:\n\n  import "@routecraft/ai";`,
      };
    }
    const result = await pin(config, {
      client,
      credentials: async () => {
        const { credentialsConfigOf, openCredentialStore } =
          await import("@routecraft/routecraft");
        opened ??= await openCredentialStore(credentialsConfigOf(config));
        return opened.store;
      },
    });

    const lines: string[] = [];
    for (const each of result.clients) {
      const total = each.added.length + each.changed.length + each.unchanged;
      lines.push(
        `${each.id}: ${total} tools, ${each.added.length} added, ${each.changed.length} changed, ${each.removed.length} removed`,
      );
      for (const tool of each.added) {
        lines.push(`  + ${printable(tool.name)}  (class: ${tool.class})`);
      }
      for (const name of each.changed) lines.push(`  ~ ${printable(name)}`);
      for (const name of each.removed) lines.push(`  - ${printable(name)}`);
    }
    const file = displayPath(root, result.path);
    if (result.clients.length > 0) {
      lines.push(
        result.written
          ? `Wrote ${file}. Check the class of each added tool, review the diff, and commit it to approve.`
          : `${file} is up to date.`,
      );
    }
    const errors = result.failed.map(
      (each) =>
        `"${each.id}" was not listed, and its locked tools are unchanged: ${each.reason}`,
    );
    return {
      code: errors.length > 0 ? 1 : 0,
      ...(lines.length > 0 ? { output: lines.join("\n") } : {}),
      ...(errors.length > 0 ? { error: errors.join("\n") } : {}),
    };
  } catch (error: unknown) {
    return { code: 1, error: messageOf(error) };
  } finally {
    if (opened?.owned) await opened.store.close();
  }
}
