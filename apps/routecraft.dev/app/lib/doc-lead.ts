/**
 * The prose a docs page advertises when its frontmatter names no description.
 *
 * Shared with `scripts/generate-docs-catalogue`, which reads it once per page
 * at build time. Kept apart from the frontmatter parser so the generator can
 * import it without pulling in anything that reads generated modules.
 */

/**
 * First real prose sentence of a page body, trimmed to a meta description.
 * Headings, code, component tags, links, tables and admonitions are skipped.
 */
export function docLead(body: string): string | undefined {
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^(#|`{3}|\{%|\[|<|\||-|\*|>|=|!)/.test(line)) continue
    if (!line.includes(' ')) continue
    const clean = line
      .replace(/\{%[^%]*%\}/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .trim()
    if (clean.length < 20) continue
    return clean.length > 155 ? `${clean.slice(0, 152).trimEnd()}…` : clean
  }
  return undefined
}
