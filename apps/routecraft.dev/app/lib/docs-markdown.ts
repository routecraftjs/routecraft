/**
 * The plain-markdown view of a page, for the copy-page control.
 *
 * Replaces the webpack virtual module that inlined every cleaned page at
 * compile time. The per-page mirrors are already published as static files
 * under `/raw/**`, so the URL helpers point at those, and the inline copy is
 * cleaned on demand from the same source the page renders from.
 */

import { cleanMdx } from '@/lib/clean-mdx'

const SOURCES = {
  ...import.meta.glob<string>('../content/docs/**/index.mdx', {
    eager: true,
    query: '?raw',
    import: 'default',
  }),
  ...import.meta.glob<string>('../content/docs-next/**/index.mdx', {
    eager: true,
    query: '?raw',
    import: 'default',
  }),
}

function pathnameOf(path: string): string {
  const released = path.indexOf('/content/docs/')
  if (released !== -1) {
    return `/docs${path.slice(released + '/content/docs'.length).replace(/\/index\.mdx$/, '')}`
  }
  const next = path.indexOf('/content/docs-next/')
  return `/docs/next${path.slice(next + '/content/docs-next'.length).replace(/\/index\.mdx$/, '')}`
}

const PAGES = new Map<string, string>(
  Object.entries(SOURCES).map(([path, source]) => [pathnameOf(path), source]),
)

export function getPageMarkdown(pathname: string): string | null {
  const source =
    PAGES.get(pathname) ?? PAGES.get(pathname.replace(/\/$/, '')) ?? null

  return source === null ? null : cleanMdx(source)
}

export function getPageRawUrl(pathname: string, basePath?: string): string {
  const normalized = pathname === '/' ? '/index' : pathname.replace(/\/$/, '')
  return `${basePath || ''}/raw${normalized}.md`
}

/**
 * The whole-channel bundle for the channel the reader is on, so "copy all docs"
 * from `/docs/next` hands over the in-development set rather than the released
 * one.
 */
export function getAllDocsRawUrl(basePath?: string, pathname?: string): string {
  const isNext =
    typeof pathname === 'string' && /^\/docs\/next(\/|$)/.test(pathname)

  return `${basePath || ''}${isNext ? '/raw/docs-next.md' : '/raw/docs.md'}`
}
