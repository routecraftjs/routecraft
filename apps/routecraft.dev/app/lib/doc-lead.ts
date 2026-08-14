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
 * never ends mid-word. A run long enough to have no boundary to cut at falls
 * back to the index, where a trailing high surrogate is dropped rather than
 * emitted as half a character.
 */
function truncate(text: string): string {
  if (text.length <= MAX_LENGTH) return text

  const cut = text.slice(0, MAX_LENGTH - 1)
  const boundary = cut.lastIndexOf(' ')
  const kept =
    boundary > 0 ? cut.slice(0, boundary) : cut.replace(/[\uD800-\uDBFF]$/, '')

  return `${kept.trimEnd()}…`
}

/** An opening fence, as its delimiter character and length. */
function fenceOpener(line: string): { char: string; length: number } | null {
  const match = /^(`{3,}|~{3,})/.exec(line)
  return match ? { char: match[1][0], length: match[1].length } : null
}

/**
 * CommonMark closes a fence only on the same character, at least as long as the
 * opener and alone on its line. Toggling on any fence-like line instead let a
 * `~~~` example inside a backtick block reopen the prose scan mid-code.
 */
function closesFence(
  line: string,
  open: { char: string; length: number },
): boolean {
  const match = new RegExp(`^\\${open.char}{${open.length},}\\s*$`).exec(line)
  return match !== null
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
  let fence: { char: string; length: number } | null = null

  for (const raw of body.split('\n')) {
    const line = raw.trim()

    if (fence) {
      if (closesFence(line, fence)) fence = null
      continue
    }

    const opener = fenceOpener(line)
    if (opener) {
      fence = opener
      continue
    }

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
