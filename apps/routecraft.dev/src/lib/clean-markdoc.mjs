import {
  FIGURE_TEXT,
  figureImagePath,
} from '../components/figures/manifest.mjs'

/**
 * Production origin for the absolute image URLs in cleaned markdown. Raw
 * markdown is read away from the site (an LLM crawl, a dev.to cross-post, a
 * pasted page), where a root-relative image resolves against the wrong host or
 * nothing at all. Mirrors the fallback in `lib/site.ts`.
 */
const SITE_ORIGIN = 'https://routecraft.dev'

/**
 * Strips Markdoc-specific syntax from raw `.md` source and returns
 * clean, standard markdown suitable for copying or serving as a raw file.
 *
 * @param {string} source  Raw Markdoc-flavored markdown
 * @param {string} [title] Optional title to prepend as an H1 heading
 * @returns {string}
 */
export function cleanMarkdoc(source, title) {
  let out = source

  // A cross-post declares its original publication in frontmatter. The raw
  // markdown is exactly the surface that gets scraped and republished, so the
  // attribution must survive the frontmatter strip below; it is re-emitted
  // under the title at the end.
  const canonical = out.match(
    /^---[\s\S]*?^canonical:\s*(https?:\S+)\s*$[\s\S]*?---/m,
  )?.[1]

  // Strip YAML frontmatter
  out = out.replace(/^---[\s\S]*?---\n*/, '')

  // Remove inline class annotations like {% .lead %}
  out = out.replace(/\s*\{%\s*\.[\w-]+\s*%\}/g, '')

  // Remove code-tabs / code-tab wrappers (keep the fenced code blocks inside)
  out = out.replace(/^\{%\s*\/?code-tabs\s*%\}\n?/gm, '')
  out = out.replace(
    /^\{%\s*code-tab\s+label="([^"]*)"[^%]*%\}\n?/gm,
    '**$1:**\n',
  )
  out = out.replace(/^\{%\s*\/code-tab\s*%\}\n?/gm, '')

  // Convert callouts to blockquotes
  out = out.replace(
    /\{%\s*callout\s+type="(\w+)"(?:\s+title="([^"]*)")?\s*%\}\n?([\s\S]*?)\{%\s*\/callout\s*%\}/g,
    (_match, type, calloutTitle, content) => {
      const label = calloutTitle
        ? `**${type.charAt(0).toUpperCase() + type.slice(1)}: ${calloutTitle}**`
        : `**${type.charAt(0).toUpperCase() + type.slice(1)}**`
      const lines = content.trim().split('\n')
      return `> ${label}\n>\n${lines.map((l) => `> ${l}`).join('\n')}`
    },
  )

  // Convert a figure to a real markdown image of its exported PNG. The figure
  // itself is a React drawing that only exists on the site, so outside it the
  // tag is noise; the light PNG and the figure's alt text are what a reader or
  // a crawler can actually use. Italic caption underneath, as a plain reader
  // has no figcaption.
  out = out.replace(
    /^\{%\s*diagram\s+id="([^"]+)"[^%]*\/%\}$/gm,
    (match, id) => {
      const text = FIGURE_TEXT[id]
      // An unknown id means a typo or a renamed figure. Leave the tag alone
      // rather than emit an image link that 404s.
      if (!text) return match
      const url = `${SITE_ORIGIN}${figureImagePath(id)}`
      return `![${text.alt}](${url})\n\n_${text.caption}_`
    },
  )

  // Remove quick-links wrapper
  out = out.replace(/^\{%\s*\/?quick-links\s*%\}\n?/gm, '')

  // Convert self-closing quick-link to a list item
  out = out.replace(
    /^\{%\s*quick-link\s+title="([^"]*)"(?:\s+icon="[^"]*")?\s+href="([^"]*)"(?:\s+description="([^"]*)")?\s*\/%\}\n?/gm,
    (_match, linkTitle, href, desc) =>
      desc
        ? `- [${linkTitle}](${href}) -- ${desc}\n`
        : `- [${linkTitle}](${href})\n`,
  )

  // Strip badge tags, keep inner text
  out = out.replace(
    /\{%\s*badge(?:\s+color="[^"]*")?\s*%\}([\s\S]*?)\{%\s*\/badge\s*%\}/g,
    '[$1]',
  )

  // Collapse 3+ consecutive blank lines to 2
  out = out.replace(/\n{3,}/g, '\n\n')

  // Prepend title as H1 if provided
  if (title) {
    out = `# ${title}\n\n${out.trim()}\n`
  } else {
    out = out.trim() + '\n'
  }

  // Attribution line for cross-posts, directly under the title so a reader
  // (or an LLM) of the raw file sees where the article's home is.
  if (canonical) {
    out = out.replace(/\n\n/, `\n\n_Originally published at ${canonical}_\n\n`)
  }

  return out
}
