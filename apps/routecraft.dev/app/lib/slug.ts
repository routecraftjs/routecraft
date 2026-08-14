/**
 * Convert a display string to a URL-friendly anchor slug (lowercase,
 * whitespace to hyphens). Shared by the docs index components so the
 * DOM ids they render and the TOC sections they export stay in sync.
 */
export function slug(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '-')
}

/**
 * Lookup key for a heading anchor: comparable across `RC1001`, `rc-1001` and
 * `RC 1001`. The generator keys its anchor map with this and the site reads it
 * back with the same function, so the two halves cannot drift apart.
 */
export function anchorKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}
