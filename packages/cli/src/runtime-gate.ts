/**
 * Runtime gate for the craft CLI.
 *
 * The CLI is Bun-only. Users on Node embed @routecraft/routecraft
 * programmatically instead of going through the CLI.
 *
 * Exposed as a pure function so unit tests can pass arbitrary version strings
 * without spawning real bun processes.
 */

const MIN_BUN_VERSION = { major: 1, minor: 1, patch: 0 } as const;

const INSTALL_URL = "https://bun.com/docs/installation";
const EMBEDDING_DOC_URL =
  "https://routecraft.dev/docs/advanced/programmatic-invocation";

export type RuntimeGateResult = { ok: true } | { ok: false; message: string };

export function checkBunRuntime(
  bunVersion: string | undefined = process.versions["bun"],
): RuntimeGateResult {
  if (!bunVersion) {
    return {
      ok: false,
      message:
        `[routecraft] The craft CLI requires Bun. ` +
        `Install Bun from ${INSTALL_URL}, ` +
        `or embed @routecraft/routecraft programmatically (see ${EMBEDDING_DOC_URL}).`,
    };
  }

  const stripped = bunVersion.split("-")[0] ?? "";
  const [majorStr, minorStr, patchStr] = stripped.split(".");
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const patch = Number(patchStr ?? "0");

  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch)
  ) {
    return {
      ok: false,
      message:
        `[routecraft] Could not parse Bun version "${bunVersion}". ` +
        `Routecraft requires Bun ${formatVersion(MIN_BUN_VERSION)} or later. ` +
        `Upgrade Bun: ${INSTALL_URL}.`,
    };
  }

  const meetsFloor =
    major > MIN_BUN_VERSION.major ||
    (major === MIN_BUN_VERSION.major &&
      (minor > MIN_BUN_VERSION.minor ||
        (minor === MIN_BUN_VERSION.minor && patch >= MIN_BUN_VERSION.patch)));

  if (!meetsFloor) {
    return {
      ok: false,
      message:
        `[routecraft] Bun ${bunVersion} is not supported. ` +
        `Routecraft requires Bun ${formatVersion(MIN_BUN_VERSION)} or later. ` +
        `Upgrade Bun: ${INSTALL_URL}.`,
    };
  }

  return { ok: true };
}

function formatVersion(v: typeof MIN_BUN_VERSION): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}
