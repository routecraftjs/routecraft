// Self-reference via the published specifier so ecosystem augmentations of
// `CraftConfig` reach this module, as in project.ts.
import type { CraftConfig } from "@routecraft/routecraft";
import { rcError } from "./error.ts";
import { applicationPluginsOf } from "./project.ts";
import { PluginHost } from "./kernel/host.ts";
import type { CredentialStore } from "./kernel/credentials.ts";
import type { CredentialLogin, ToolingCommand } from "./kernel/tooling.ts";

/** One installed plugin's tooling, as a tool around the application reads it. */
export interface InstalledTooling {
  /** The plugin's install id. */
  readonly plugin: string;
  /** The plugin's namespace: the first word of each of its commands. */
  readonly namespace: string;
  /** The plugin's commands by key; empty when it declares none. */
  readonly commands: Readonly<Record<string, ToolingCommand>>;
  /** The logins the plugin's configuration declares; empty when it has none. */
  readonly logins: readonly CredentialLogin[];
}

/**
 * The tooling of every plugin a configuration installs, in install order,
 * defaults and brought plugins included. Nothing is bound or started: the
 * plugin list is resolved the way the application resolves it, and each
 * descriptor's `tooling` is read off it.
 *
 * @param config - The project's configuration
 * @returns One entry per plugin that declares `tooling`
 * @throws RC1101, RC1102, RC1104 and the other resolution faults the
 *   application itself would raise for this plugin list
 * @throws RC1117 when a plugin's `logins` does not return an array of logins
 * @throws RC5003 when two logins share an id, which `craft connect <id>`
 *   could not tell apart, or an owner, whose credential they would share
 */
export function pluginTooling(config: CraftConfig): InstalledTooling[] {
  const host = new PluginHost(applicationPluginsOf(config));
  const out: InstalledTooling[] = [];
  const ids = new Set<string>();
  const owners = new Set<string>();
  for (const { plugin, id, namespace } of host.listed) {
    const tooling = plugin.tooling;
    if (tooling === undefined) continue;
    const logins: unknown =
      tooling.logins === undefined ? [] : tooling.logins();
    // Array.from fills a sparse array's holes, which `every` would skip.
    if (!Array.isArray(logins) || !Array.from(logins).every(isLogin)) {
      throw rcError("RC1117", undefined, {
        message: `Invalid plugin "${id}": tooling.logins must return an array of { id, owner, description, login(store, io) }.`,
      });
    }
    for (const login of logins as CredentialLogin[]) {
      if (ids.has(login.id) || owners.has(login.owner)) {
        throw rcError("RC5003", undefined, {
          message: `Two logins are named "${login.id}" or keep their credential as "${login.owner}"; give the clients distinct names.`,
          suggestion:
            "Rename one of the clients, so each name craft connect takes and each stored credential is its own.",
        });
      }
      ids.add(login.id);
      owners.add(login.owner);
    }
    out.push({
      plugin: id,
      namespace,
      commands: tooling.commands ?? {},
      logins: logins as CredentialLogin[],
    });
  }
  return out;
}

function isLogin(value: unknown): value is CredentialLogin {
  if (typeof value !== "object" || value === null) return false;
  const login = value as Partial<CredentialLogin>;
  return (
    typeof login.id === "string" &&
    typeof login.owner === "string" &&
    typeof login.description === "string" &&
    typeof login.login === "function"
  );
}

/**
 * A view of a credential store that reaches only the given owners: what a
 * plugin's tooling command is handed, so it reads and writes the credentials
 * its own logins declare and no other plugin's.
 *
 * Closing the view does nothing; whoever opened the store closes it.
 *
 * @param store - The project's credential store
 * @param owners - The owners the view may reach
 * @param plugin - The plugin the view is for, named in a refusal
 * @returns The narrowed store; any other owner is refused with `RC5072`
 */
export function scopedCredentialStore(
  store: CredentialStore,
  owners: ReadonlySet<string>,
  plugin: string,
): CredentialStore {
  const allow = (owner: string): void => {
    if (owners.has(owner)) return;
    throw rcError("RC5072", undefined, {
      message: `Plugin "${plugin}" asked for the credential of "${owner}", which none of its own logins declares. A tooling command reaches only the credentials its plugin's tooling.logins name.`,
    });
  };
  return {
    async get(owner) {
      allow(owner);
      return store.get(owner);
    },
    async put(owner, value, options) {
      allow(owner);
      return store.put(owner, value, options);
    },
    async delete(owner, options) {
      allow(owner);
      return store.delete(owner, options);
    },
    async list() {
      return (await store.list()).filter((held) => owners.has(held.owner));
    },
    async close() {},
  };
}
