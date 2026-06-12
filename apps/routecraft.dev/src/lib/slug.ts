/**
 * Convert a display string to a URL-friendly anchor slug (lowercase,
 * whitespace to hyphens). Shared by the docs index components so the
 * DOM ids they render and the TOC sections they export stay in sync.
 */
export function slug(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '-')
}
