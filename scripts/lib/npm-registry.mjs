/**
 * Reads from the public npm registry for the release scripts. A 404 is an
 * answer (the package or version was never published); any other failure
 * throws, so a registry outage is never mistaken for "not published".
 */

/**
 * Fetch JSON from the npm registry. A 404 resolves to null so a package that
 * has never been published reads as absent rather than an error.
 *
 * @param {string} path - Registry path, already URI-encoded per segment
 * @param {string} [accept] - Accept header, e.g. the abbreviated metadata type
 * @returns {Promise<any>}
 */
export async function registryJson(path, accept) {
  let res;
  try {
    res = await fetch(`https://registry.npmjs.org/${path}`, {
      headers: accept ? { accept } : {},
      // Fail loudly instead of letting a stalled connection hang the job.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`npm registry lookup failed for ${path}`, { cause: err });
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for ${path}`);
  }
  return await res.json();
}

/**
 * The published manifest of one exact version, or null when that version was
 * never published. Its `gitHead` is the commit npm published it from.
 *
 * @param {string} name
 * @param {string} version
 * @returns {Promise<{ version: string, gitHead?: string } | null>}
 */
export function publishedVersion(name, version) {
  return registryJson(
    `${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
}
