/**
 * Reading a runtime's own version string.
 *
 * Two places need it and they must not answer differently: the CLI gate
 * refuses a Bun below the supported floor, and the ops client decides
 * whether this Bun re-sends a dropped non-idempotent request by itself.
 * Written twice, the two copies disagreed on the same input within one
 * release: one read a two-segment `"1.4"` as `1.4.0` and the other as
 * unparseable.
 */

/** A SemVer core, with prerelease and build metadata already dropped. */
export interface RuntimeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Parse a runtime version string, or `undefined` when it is not one.
 *
 * A missing patch (or minor) segment reads as zero, matching how a
 * runtime that reports `"1.4"` means `1.4.0`. Prerelease and build
 * metadata are stripped per SemVer, so a canary compares as its release.
 *
 * @internal
 */
export function parseRuntimeVersion(
  version: string,
): RuntimeVersion | undefined {
  const [major, minor, patch] = (version.split(/[-+]/)[0] ?? "")
    .split(".")
    .map((segment) => (segment === "" ? Number.NaN : Number(segment)));
  if (major === undefined || !Number.isInteger(major)) return undefined;
  if (minor !== undefined && !Number.isInteger(minor)) return undefined;
  if (patch !== undefined && !Number.isInteger(patch)) return undefined;
  return { major, minor: minor ?? 0, patch: patch ?? 0 };
}

/**
 * Negative when `a` is older than `b`, zero when they are the same core.
 *
 * @internal
 */
export function compareRuntimeVersion(
  a: RuntimeVersion,
  b: RuntimeVersion,
): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}
