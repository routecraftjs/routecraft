#!/usr/bin/env bun

/**
 * Writes `public/sitemap.xml`.
 *
 * The static build serves `public/` as-is, so the sitemap is produced here
 * rather than by a route. It covers the home page, the released docs tree, the
 * blog, the changelog, the cheat sheet, the `/raw/**` markdown mirrors and the
 * two llms.txt bundles.
 *
 * Two omissions are load-bearing and checked by the deploy gate:
 *
 *   1. The `/docs/next` channel is an in-development mirror of the latest docs
 *      and is noindex, so neither its pages nor its raw mirrors are advertised.
 *   2. A cross-posted article (frontmatter `canonical` pointing at another
 *      site) canonicalises elsewhere, so listing it here would claim a URL the
 *      page itself tells crawlers not to index in our favour. Its raw mirror
 *      goes with it; both stay served for readers and direct links.
 *
 * Run as: bun scripts/generate-sitemap.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { siteUrl } from '../app/lib/site'
import {
  getPublishedPosts,
  hasBlogContent,
  lastModifiedDate,
} from './blog-posts'
import { CONTENT_DIR, PUBLIC_DIR } from './paths'

type ChangeFrequency = 'weekly' | 'monthly'

interface SitemapEntry {
  url: string
  lastModified?: Date
  changeFrequency: ChangeFrequency
  priority: number
}

const buildTime = new Date()

const DOCS_DIR = path.join(CONTENT_DIR, 'docs')
const RAW_DIR = path.join(PUBLIC_DIR, 'raw')

/**
 * A page's directory-relative URL and its file mtime, for every authored page
 * under `baseDir`. A directory is a page when it holds an `index.mdx`; a
 * directory without one (`_data`) still gets walked for pages below it.
 *
 * Entries are sorted so the sitemap is byte-identical between builds on hosts
 * whose `readdir` order differs.
 */
function collectContentPages(
  baseDir: string,
  urlPrefix: string,
): Array<{ url: string; mtime: Date }> {
  const pages: Array<{ url: string; mtime: Date }> = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true })
  } catch (error) {
    console.warn(`Could not read directory ${baseDir}:`, error)
    return pages
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const fullPath = path.join(baseDir, entry.name)
    const url = `${urlPrefix}/${entry.name}`

    const indexPath = path.join(fullPath, 'index.mdx')
    if (fs.existsSync(indexPath)) {
      pages.push({ url: `${url}/`, mtime: fs.statSync(indexPath).mtime })
    }

    pages.push(...collectContentPages(fullPath, url))
  }

  return pages
}

/** Every `.md` under `dir`, as a site-relative URL plus its mtime. */
function collectRawMarkdown(
  dir: string,
  urlPrefix: string,
): Array<{ url: string; mtime: Date }> {
  const pages: Array<{ url: string; mtime: Date }> = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined
    if (code === 'ENOENT') return pages
    throw error
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      pages.push(...collectRawMarkdown(fullPath, `${urlPrefix}/${entry.name}`))
    } else if (entry.name.endsWith('.md')) {
      pages.push({
        url: `${urlPrefix}/${entry.name}`,
        mtime: fs.statSync(fullPath).mtime,
      })
    }
  }

  return pages
}

const routes: SitemapEntry[] = []

routes.push({
  url: '/',
  lastModified: buildTime,
  changeFrequency: 'weekly',
  priority: 1.0,
})

// The docs landing page, when the content tree carries one.
const docsLandingPage = path.join(DOCS_DIR, 'index.mdx')
if (fs.existsSync(docsLandingPage)) {
  routes.push({
    url: '/docs/',
    lastModified: fs.statSync(docsLandingPage).mtime,
    changeFrequency: 'weekly',
    priority: 0.9,
  })
}

// The next channel lives in its own content root (`app/content/docs-next`) and
// is never walked here. The filter is the guarantee rather than the mechanism:
// were the two trees ever merged again, this is what keeps the channel out.
const docPages = collectContentPages(DOCS_DIR, '/docs').filter(
  (page) => page.url !== '/docs/next/' && !page.url.startsWith('/docs/next/'),
)

for (const { url, mtime } of docPages) {
  routes.push({
    url,
    lastModified: mtime,
    changeFrequency: 'monthly',
    priority: 0.8,
  })
}

if (hasBlogContent()) {
  routes.push({
    url: '/blog/',
    lastModified: buildTime,
    changeFrequency: 'weekly',
    priority: 0.9,
  })

  // lastmod comes from the post's `updated` (falling back to `date`), not the
  // file mtime: a fresh CI checkout resets every file's mtime to build time,
  // which would tell crawlers every post changed on every deploy. A malformed
  // date is omitted rather than emitted as an Invalid Date.
  for (const post of getPublishedPosts().filter((p) => !p.canonical)) {
    const lastModified = new Date(lastModifiedDate(post))
    routes.push({
      url: `/blog/${post.slug}/`,
      ...(Number.isNaN(lastModified.getTime()) ? {} : { lastModified }),
      changeFrequency: 'monthly',
      priority: 0.7,
    })
  }
}

routes.push({
  url: '/cheat-sheet/',
  lastModified: buildTime,
  changeFrequency: 'monthly',
  priority: 0.8,
})

// The changelog is top-level, outside the versioned docs tree.
routes.push({
  url: '/changelog/',
  lastModified: buildTime,
  changeFrequency: 'weekly',
  priority: 0.7,
})

const crossPostRawUrls = new Set(
  getPublishedPosts()
    .filter((post) => post.canonical)
    .map((post) => `/raw/blog/${post.slug}.md`),
)

const rawPages = collectRawMarkdown(RAW_DIR, '/raw').filter(
  ({ url }) =>
    !crossPostRawUrls.has(url) &&
    !url.startsWith('/raw/docs/next/') &&
    url !== '/raw/docs/next.md' &&
    url !== '/raw/docs-next.md',
)

for (const { url, mtime } of rawPages) {
  routes.push({
    url,
    lastModified: mtime,
    changeFrequency: 'monthly',
    priority: 0.6,
  })
}

for (const url of ['/llms.txt', '/llms-full.txt']) {
  routes.push({
    url,
    lastModified: buildTime,
    changeFrequency: 'weekly',
    priority: 0.7,
  })
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function renderEntry(entry: SitemapEntry): string {
  const lines = [`<loc>${escapeXml(`${siteUrl}${entry.url}`)}</loc>`]
  if (entry.lastModified) {
    lines.push(`<lastmod>${entry.lastModified.toISOString()}</lastmod>`)
  }
  lines.push(`<changefreq>${entry.changeFrequency}</changefreq>`)
  // `priority` is written the way JSON would: 1.0 as "1", 0.8 as "0.8".
  lines.push(`<priority>${entry.priority}</priority>`)
  return `<url>\n${lines.join('\n')}\n</url>`
}

const xml =
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...routes.map(renderEntry),
    '</urlset>',
  ].join('\n') + '\n'

const outPath = path.join(PUBLIC_DIR, 'sitemap.xml')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, xml, 'utf8')

// The origin is named out loud because every absolute URL the build emits
// carries it: the sitemap, the feed, the canonicals and the social card links.
// A card that will not preview is almost always a build whose origin is not the
// host serving it.
console.log(
  `Generated public/sitemap.xml with ${routes.length} URLs at ${siteUrl}`,
)
