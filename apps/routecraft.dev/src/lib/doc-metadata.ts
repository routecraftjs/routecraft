import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import type { Metadata } from 'next'

import { siteName } from '@/lib/site'

// Per-doc metadata, read from the page's frontmatter and lead paragraph at
// build time. Markdoc `.md` pages can't export metadata, so each doc folder
// has a thin layout.tsx that calls this with its route. Metadata merges
// deepest-first, so the leaf folder's layout sets the page's real title.

function readDocFile(route: string): { title: string; description?: string } {
  const file = path.join(process.cwd(), 'src', 'app', 'docs', route, 'page.md')
  try {
    const md = fs.readFileSync(file, 'utf8')
    const match = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    const data = match
      ? ((yaml.load(match[1]) as Record<string, unknown>) ?? {})
      : {}
    const body = match ? (match[2] ?? '') : md
    const title = typeof data.title === 'string' ? data.title : route
    const description =
      typeof data.description === 'string'
        ? data.description
        : extractLead(body)
    return { title, description }
  } catch {
    return { title: route }
  }
}

// First real prose sentence of the body, for a meta description. Skips
// headings, code, markdoc tags, links/back-links, tables, and admonitions.
function extractLead(body: string): string | undefined {
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

export function docMetadata(route: string): Metadata {
  const { title, description } = readDocFile(route)
  const url = route ? `/docs/${route}` : '/docs'
  // Absolute title: nested doc layouts each set a title, so the root template
  // ('%s - Routecraft') doesn't cascade reliably. Spell it out instead.
  const fullTitle = `${title} · Docs - ${siteName}`
  return {
    title: { absolute: fullTitle },
    description,
    alternates: { canonical: url },
    openGraph: { type: 'article', title: fullTitle, description, url },
    twitter: { card: 'summary_large_image', title: fullTitle, description },
  }
}
