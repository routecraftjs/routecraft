/**
 * The prose a docs page advertises when its frontmatter names no description.
 *
 * Shared with `scripts/generate-docs-catalogue`, which reads it once per page
 * at build time. Kept apart from the frontmatter parser so the generator can
 * import it without pulling in anything that reads generated modules.
 */

/** Longest meta description a search result will show before truncating. */
const MAX_LENGTH = 155

/**
 * Trims to a word boundary rather than a character index, so a description
 * never ends mid-word and never splits a surrogate pair into a lone half.
 */
function truncate(text: string): string {
  if (text.length <= MAX_LENGTH) return text

  const cut = text.slice(0, MAX_LENGTH - 1)
  const boundary = cut.lastIndexOf(' ')
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`
}

/**
 * First real prose sentence of a page body, trimmed to a meta description.
 * Headings, code, component tags, links, tables and admonitions are skipped.
 *
 * Fenced code is tracked rather than skipped line by line: most reference pages
 * open with a signature fence, and matching only the fence delimiters published
 * the first line of the signature as the page's description and social card.
 */
export function docLead(body: string): string | undefined {
  let inFence = false

  for (const raw of body.split('\n')) {
    const line = raw.trim()

    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    if (!line) continue
    if (/^(#|\{%|\[|<|\||-|\*|>|=|!)/.test(line)) continue
    if (!line.includes(' ')) continue

    const clean = line
      .replace(/\{%[^%]*%\}/g, '')
      // Components are authored inline as well as on their own line, and the
      // guard above only catches a line that starts with one.
      .replace(/<[^>]*>/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .trim()

    if (clean.length < 20) continue
    return truncate(clean)
  }

  return undefined
}
