/**
 * The body of one package's GitHub Release, cut to fit when it has to be.
 *
 * GitHub refuses a release body over 125000 characters, and a release whose
 * changelog section is longer than that is not an edge case: core's 0.7.0
 * section ran to 156916. The cut lands on the last whole entry that fits
 * and the body ends in a link to the full changelog at the release tag,
 * so nothing is lost and no entry is left half-rendered.
 */

/** Characters GitHub accepts in a release body. */
export const RELEASE_BODY_LIMIT = 125000;

/**
 * The section of a changesets CHANGELOG.md for one version, without its
 * heading, or an empty string when the version has no section.
 *
 * @param {string} changelog - The whole CHANGELOG.md
 * @param {string} version - The version whose section to read, e.g. "0.7.0"
 * @returns {string}
 */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.indexOf(`## ${version}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * The release body for a changelog section, truncated to `limit` with a
 * closing link to `fullChangelogUrl` when the section does not fit.
 *
 * @param {string} section - The changelog section for the release
 * @param {string} fullChangelogUrl - Where the untruncated notes live
 * @param {number} [limit] - Maximum body length
 * @returns {string}
 */
export function releaseNotes(
  section,
  fullChangelogUrl,
  limit = RELEASE_BODY_LIMIT,
) {
  if (section.length <= limit) return section;
  const footer =
    "\n\n---\n\nThese notes are cut to fit a GitHub Release. " +
    `The full notes are in the [changelog](${fullChangelogUrl}).`;
  // Never negative: a negative end counts from the back in `slice`.
  const budget = Math.max(0, limit - footer.length);
  const head = section.slice(0, budget);
  // A changesets section is a list of `- ` entries under `### ` groups, so
  // cutting before the last entry that starts inside the budget keeps every
  // entry kept whole.
  const entry = Math.max(head.lastIndexOf("\n- "), head.lastIndexOf("\n### "));
  const cut = entry > 0 ? entry : head.lastIndexOf("\n");
  const body = `${section.slice(0, cut > 0 ? cut : budget).trimEnd()}${footer}`;
  return body.slice(0, limit);
}
