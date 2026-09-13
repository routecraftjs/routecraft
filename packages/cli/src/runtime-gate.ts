/**
 * Runtime gate for the craft CLI.
 *
 * The CLI is Bun-only. Users on Node embed @routecraft/routecraft
 * programmatically instead of going through the CLI.
 *
 * Exposed as a pure function so unit tests can pass arbitrary version strings
 * without spawning real bun processes.
 *
 * The version itself is read by `parseRuntimeVersion` from core, shared
 * with the ops client's own Bun check: written twice, the two parsers
 * disagreed on the same string within one release.
 */

import {
  compareRuntimeVersion,
  parseRuntimeVersion,
  type RuntimeVersion,
} from "@routecraft/routecraft";

const MIN_BUN_VERSION: RuntimeVersion = { major: 1, minor: 1, patch: 0 };

const INSTALL_URL = "https://bun.com/docs/installation";
const EMBEDDING_DOC_URL =
  "https://routecraft.dev/docs/advanced/programmatic-invocation";

export type RuntimeGateResult = { ok: true } | { ok: false; message: string };

// Accept `null` (not `undefined`) to express "not running on Bun" so tests can
// reliably exercise the missing-bun path. JS default-parameter semantics
// re-apply the default for explicit `undefined`, which would otherwise let
// `process.versions.bun` leak in when the suite runs under Bun.
export function checkBunRuntime(
  bunVersion: string | null = process.versions["bun"] ?? null,
): RuntimeGateResult {
  const version = bunVersion;

  if (!version) {
    return {
      ok: false,
      message:
        `[routecraft] The craft CLI requires Bun. ` +
        `Install Bun from ${INSTALL_URL}, ` +
        `or embed @routecraft/routecraft programmatically (see ${EMBEDDING_DOC_URL}).`,
    };
  }

  const parsed = parseRuntimeVersion(version);

  if (parsed === undefined) {
    return {
      ok: false,
      message:
        `[routecraft] Could not parse Bun version "${version}". ` +
        `Routecraft requires Bun ${formatVersion(MIN_BUN_VERSION)} or later. ` +
        `Upgrade Bun: ${INSTALL_URL}.`,
    };
  }

  if (compareRuntimeVersion(parsed, MIN_BUN_VERSION) < 0) {
    return {
      ok: false,
      message:
        `[routecraft] Bun ${version} is not supported. ` +
        `Routecraft requires Bun ${formatVersion(MIN_BUN_VERSION)} or later. ` +
        `Upgrade Bun: ${INSTALL_URL}.`,
    };
  }

  return { ok: true };
}

function formatVersion(v: RuntimeVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}
