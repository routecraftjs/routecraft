import yaml from 'js-yaml'

export interface ParsedFrontmatter {
  data: Record<string, unknown>
  body: string
}

// Splits a Markdown/Markdoc document into its YAML frontmatter and body.
// Normalises CRLF first so Windows-authored content parses the same as LF.
// Shared by the blog reader and the per-doc metadata reader so the two can't
// drift on delimiter handling.
export function parseFrontmatter(source: string): ParsedFrontmatter {
  const normalized = source.replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { data: {}, body: normalized }
  const data = (yaml.load(match[1]) as Record<string, unknown>) ?? {}
  return { data, body: match[2] ?? '' }
}
