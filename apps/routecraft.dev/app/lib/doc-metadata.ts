import fs from 'node:fs'
import path from 'node:path'

import { parseFrontmatter } from '@/lib/frontmatter'
import { documentsHref } from '@/lib/docs-catalogue'
import { compactMeta, type PageHead } from '@/lib/page-head'
import { absoluteUrl, canonicalPath, siteName } from '@/lib/site'

// Per-doc metadata, read from the page's frontmatter and lead paragraph at
// build time. A route addresses the same file the router renders, so the title
// a page advertises and the title it shows come from one source.

function isNextRoute(route: string): boolean {
  return route === 'next' || route.startsWith('next/')
}

// The next channel is a separate snapshot of the content tree rather than a
// folder inside the released one, so its routes read from `content/docs-next`.
function docFilePath(route: string): string {
  const isNext = isNextRoute(route)
  return path.join(
    process.cwd(),
    'app',
    'content',
    isNext ? 'docs-next' : 'docs',
    isNext ? route.replace(/^next\/?/, '') : route,
    'index.mdx',
  )
}

function readDocFile(route: string): { title: string; description?: string } {
  try {
    const md = fs.readFileSync(docFilePath(route), 'utf8')
    const { data, body } = parseFrontmatter(md)
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
// headings, code, component tags, links/back-links, tables, and admonitions.
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

export function docMetadata(route: string): PageHead {
  const { title, description } = readDocFile(route)
  // The in-development /docs/next channel mirrors the latest docs. It is kept
  // out of search indexes and canonicalises to its latest-channel equivalent so
  // engines consolidate on the released page rather than the preview.
  const isNext = isNextRoute(route)
  const latestRoute = isNext ? route.replace(/^next\/?/, '') : route
  const latestHref = latestRoute ? `/docs/${latestRoute}` : '/docs'
  // A page that only exists on the next channel documents unreleased API, so
  // it has no released equivalent to consolidate on; pointing at one would
  // canonicalise to a URL that 404s. Those pages canonicalise to themselves.
  const canonicalHref =
    isNext && !documentsHref('latest', latestHref)
      ? `/docs/${route}`
      : latestHref
  const url = absoluteUrl(canonicalPath(canonicalHref))
  // Absolute title: the docs shell sets a title of its own and a page title is
  // not composed from its ancestors, so spell the full one out here.
  const fullTitle = `${title} · Docs - ${siteName}`
  return {
    title: fullTitle,
    meta: compactMeta([
      description ? { name: 'description', content: description } : null,
      isNext ? { name: 'robots', content: 'noindex, follow' } : null,
      { property: 'og:title', content: fullTitle },
      description ? { property: 'og:description', content: description } : null,
      { property: 'og:url', content: url },
      { property: 'og:type', content: 'article' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: fullTitle },
      description
        ? { name: 'twitter:description', content: description }
        : null,
    ]),
    links: [{ rel: 'canonical', href: url }],
  }
}
