/**
 * The prelude every command that reaches an instance shares: resolve the
 * settings, name a settings problem, and build the client over them.
 *
 * One place rather than one per command because it is policy, not
 * boilerplate. A broken settings file must mean the same thing to `exec`,
 * `ops` and `chat`, and a failure that is not a settings problem must
 * surface as the crash it is on every one of them.
 */

import type { ViewNote } from "./format.js";
import { createOpsClient, type OpsClient } from "./ops-client.js";
import {
  resolveSettings,
  SettingsError,
  type OutputFormat,
  type ResolvedSettings,
  type SettingsOverrides,
} from "./settings.js";

export type Prepared =
  | {
      ok: true;
      settings: ResolvedSettings;
      client: OpsClient;
      format: OutputFormat;
      /** Whether the reads will be authenticated, for the renderers that say so. */
      view: ViewNote;
    }
  | {
      /** A settings problem, in the operator's terms. Exit with the usage code. */
      ok: false;
      error: string;
    };

/** Resolve the settings and build the client, or say why that failed. */
export function prepare(overrides: SettingsOverrides): Prepared {
  let settings: ResolvedSettings;
  try {
    settings = resolveSettings(overrides);
  } catch (error: unknown) {
    if (error instanceof SettingsError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  const client = createOpsClient(settings);
  return {
    ok: true,
    settings,
    client,
    format: settings.format.value,
    view: client.authenticated ? "authenticated" : "anonymous",
  };
}
