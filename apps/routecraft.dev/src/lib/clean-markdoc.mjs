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

  return out
}
