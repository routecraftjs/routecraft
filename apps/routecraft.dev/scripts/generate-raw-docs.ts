#!/usr/bin/env bun

/**
 * Generates clean markdown files in public/raw/ for every content page, on both
 * channels, plus a combined bundle per channel:
 *
 *   released      public/raw/docs/**.md      public/raw/docs.md, public/llms-full.txt
 *   development   public/raw/docs/next/**.md public/raw/docs-next.md, public/llms-full-next.txt
 *
 * The next-channel outputs exist so the in-development docs can be handed to a
 * model when testing against the canary. They are deliberately absent from
 * llms.txt and the sitemap, matching that channel's noindex.
 *
 * Run as: bun scripts/generate-raw-docs.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import { cleanMdx } from '../app/lib/clean-mdx'
import { navigation } from '../app/lib/navigation'
import { parseFrontmatter } from '../app/lib/frontmatter'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTENT_DIR = path.join(ROOT, 'app', 'content')
const OUT_DIR = path.join(ROOT, 'public', 'raw')

/**
 * Content root to URL. The in-development channel is materialised in its own
 * directory rather than under `docs/`, so it is rebased here; everything else
 * mirrors its path.
 */
function pageUrl(file: string): string {
  const route = file.replace(/(^|\/)index\.mdx$/, '')
  if (route === '') return '/'
  if (route === 'docs-next') return '/docs/next'
  if (route.startsWith('docs-next/')) {
    return `/docs/next/${route.slice('docs-next/'.length)}`
  }
  return `/${route}`
}

// Derive section ordering from the shared navigation config.
// Skip the root page ('/') since it will become the marketing page.
const NAV_ORDER = navigation.map((section) => ({
  section: section.title,
  pages: section.links.map((link) => link.href).filter((href) => href !== '/'),
}))

// Pages excluded from the combined docs.md (changelog has no how-to value,
// section landing pages are just navigation links repeated from child pages).
// /docs/introduction is kept because it has real content ("What is Routecraft").
const SKIP_IN_COMBINED = new Set([
  '/changelog',
  ...navigation
    .map((s) => s.href)
    .filter((href) => href !== '/' && href !== '/docs/introduction'),
])

function extractTitle(md: string): string | undefined {
  const match = md.match(/^---[\s\S]*?---/)
  if (!match) return undefined
  const titleMatch = match[0].match(/^title:\s*(.+)$/m)
  return titleMatch
    ? titleMatch[1].trim().replace(/^["']|["']$/g, '')
    : undefined
}

// Drafts and unpublished posts must not be mirrored to public/raw: those files
// are publicly fetchable and get listed in the sitemap, so emitting one would
// leak a draft's full content and make it discoverable. The blog index, RSS
// feed, and per-post robots meta already hide drafts; this keeps the raw mirror
// consistent with them. Detection goes through the same `parseFrontmatter`
// (js-yaml) and the same rule as `app/lib/blog.ts`, so the two can't drift on
// YAML boolean spellings (`draft: True`, `draft: yes`, `draft: true # note`).
function isUnpublished(md: string): boolean {
  const { data } = parseFrontmatter(md)
  return Boolean(data.draft) || data.published === false
}

interface Page {
  title: string | undefined
  cleaned: string
}

// Build a map of url -> { title, cleaned markdown }, per channel. The
// in-development channel gets the same treatment as the released one: it is the
// canary readers (and their models) work against before a release, so leaving it
// out of the mirror is what made every /raw/docs/next/*.md a 404.
const pages = new Map<string, Page>()
const nextPages = new Map<string, Page>()

/**
 * Points a next-channel mirror's docs links at the next channel.
 *
 * The rendered site resolves this per channel at render time, which is why the
 * content snapshot is a verbatim copy. A markdown mirror has no renderer, so
 * the same resolution is applied here; without it every link in the
 * in-development bundle would send a reader back to the released page.
 *
 * The negative lookahead keeps a sibling page like /docs/next-steps intact.
 */
function withNextChannelLinks(markdown: string): string {
  return markdown
    .replace(/\]\(\/docs\/(?!next(?:[/)#?]|$))/g, '](/docs/next/')
    .replace(/\]\(\/docs\)/g, '](/docs/next)')
    .replace(
      /\]\(https:\/\/routecraft\.dev\/docs\/(?!next(?:[/)#?]|$))/g,
      '](https://routecraft.dev/docs/next/',
    )
}

const files = [
  ...new Glob('**/index.mdx').scanSync({ cwd: CONTENT_DIR }),
].sort()

for (const file of files) {
  const url = pageUrl(file)
  const md = fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8')
  if (isUnpublished(md)) continue
  const title = extractTitle(md)
  const cleaned = cleanMdx(md, title)
  // Bounded on a segment: a sibling page like /docs/next-steps is a released
  // page, not the in-development channel.
  const isNextChannel = url === '/docs/next' || url.startsWith('/docs/next/')
  ;(isNextChannel ? nextPages : pages).set(url, {
    title,
    cleaned: isNextChannel ? withNextChannelLinks(cleaned) : cleaned,
  })
}

// Clean the output directory before regenerating. This script owns public/raw
// entirely and rewrites it from scratch each run, so removing it first is what
// keeps the mirror in sync with the source tree: a page that became a draft, or
// was deleted or renamed, leaves no stale .md behind for the sitemap (which
// enumerates whatever files exist under public/raw) to keep advertising.
fs.rmSync(OUT_DIR, { recursive: true, force: true })

// Write individual page files
function writePages(pageMap: Map<string, Page>): void {
  for (const [url, { cleaned }] of pageMap) {
    const relPath = url === '/' ? 'index.md' : `${url.replace(/^\//, '')}.md`
    const outPath = path.join(OUT_DIR, relPath)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, cleaned, 'utf8')
  }
}

writePages(pages)
writePages(nextPages)

// Combine a channel's pages in navigation order, skipping excluded pages.
// `toChannelUrl` maps a nav href onto the channel serving it, so the next
// channel is assembled in the same order from its own copies.
function combinePages(
  pageMap: Map<string, Page>,
  toChannelUrl: (url: string) => string = (url) => url,
): string {
  const parts: string[] = []
  const seen = new Set<string>()
  // The skip list holds channel-less nav hrefs; the page map is keyed by
  // channel URLs. Map the list once, so the second loop below can compare
  // like with like instead of re-prefixing a key that is already prefixed.
  const skip = new Set([...SKIP_IN_COMBINED].map(toChannelUrl))
  for (const { section, pages: urls } of NAV_ORDER) {
    const sectionPages = urls.filter((u) => !SKIP_IN_COMBINED.has(u))
    if (sectionPages.length === 0) continue
    const sectionParts: string[] = []
    for (const url of sectionPages) {
      const channelUrl = toChannelUrl(url)
      if (seen.has(channelUrl)) continue
      seen.add(channelUrl)
      const page = pageMap.get(channelUrl)
      if (!page) continue
      sectionParts.push(page.cleaned)
    }
    if (sectionParts.length === 0) continue
    parts.push(`# ${section}\n`, ...sectionParts)
  }
  // Include any pages not in navigation (excluding root and skipped)
  for (const [url, { cleaned }] of pageMap) {
    if (url === '/' || seen.has(url) || skip.has(url)) continue
    parts.push(cleaned)
  }
  return condense(parts.join('\n'))
}

// Token-reduction passes for LLM consumption.
function condense(text: string): string {
  return (
    text
      // 1. Remove duplicate consecutive H1 headings (section title + page title)
      .replace(/^(# .+)\n\n# .+$/gm, '$1')
      // 2. Strip image lines (LLMs cannot see images)
      .replace(/^!\[.*?\]\(.*?\)\n?/gm, '')
      // 3. Keep only bun install blocks, strip npm/yarn/pnpm variants
      .replace(/\*\*(?:npm|yarn|pnpm):?\*\*:?\n```\w*\n.*?\n```\n?/gs, '')
      // 4. Collapse whitespace
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  )
}

const combined = combinePages(pages)

// The same bundle for the in-development channel. Nav hrefs are channel-less,
// so they are rebased onto /docs/next to find each page's copy.
const nextCombined = combinePages(nextPages, (url) =>
  url === '/docs' || url.startsWith('/docs/')
    ? url.replace('/docs', '/docs/next')
    : url,
)

// -- Shared constants for generated docs headers --
const BASE_URL = 'https://routecraft.dev'
const DESCRIPTION =
  'Routecraft is a code-first TypeScript automation framework that bridges traditional integration patterns (ETL, webhooks, cron jobs) and AI-native workflows (MCP tool use). Write deterministic capabilities in TypeScript, expose them to AI agents via Model Context Protocol, and keep full control over what AI can access.'

const PROJECT_LINKS = [
  `- Website: <${BASE_URL}>`,
  `- GitHub: <https://github.com/routecraftjs/routecraft>`,
  `- npm: [@routecraft/routecraft](https://www.npmjs.com/package/@routecraft/routecraft)`,
  `- npm: [@routecraft/ai](https://www.npmjs.com/package/@routecraft/ai)`,
  `- npm: [@routecraft/cli](https://www.npmjs.com/package/@routecraft/cli)`,
  `- npm: [@routecraft/os](https://www.npmjs.com/package/@routecraft/os)`,
  `- npm: [@routecraft/testing](https://www.npmjs.com/package/@routecraft/testing)`,
].join('\n')

const docsHeader =
  [
    `# Routecraft`,
    `> ${DESCRIPTION}`,
    `## Links\n\n${PROJECT_LINKS}`,
    '---',
  ].join('\n\n') + '\n\n'

// -- Write docs.md, llms-full.txt (both get the links header) --
const withHeader = docsHeader + combined
const docsPath = path.join(OUT_DIR, 'docs.md')
fs.mkdirSync(path.dirname(docsPath), { recursive: true })
fs.writeFileSync(docsPath, withHeader, 'utf8')

const llmsFullPath = path.join(ROOT, 'public', 'llms-full.txt')
fs.writeFileSync(llmsFullPath, withHeader, 'utf8')

// -- The same pair for the in-development channel --
// Kept out of llms.txt and the sitemap: /docs/next is noindex, and a model
// pointed at the site's index should get the released docs. This bundle is for
// deliberately testing against the canary, so it is addressed directly.
const nextNotice =
  '> These are the in-development docs for the next Routecraft release, built from the main ' +
  'branch. They describe API that has not shipped yet. For the released documentation, see ' +
  `<${BASE_URL}/llms-full.txt>.`

const nextWithHeader =
  [
    `# Routecraft (next)`,
    nextNotice,
    `## Links\n\n${PROJECT_LINKS}`,
    '---',
  ].join('\n\n') +
  '\n\n' +
  nextCombined

fs.writeFileSync(path.join(OUT_DIR, 'docs-next.md'), nextWithHeader, 'utf8')
fs.writeFileSync(
  path.join(ROOT, 'public', 'llms-full-next.txt'),
  nextWithHeader,
  'utf8',
)

// -- Generate llms.txt (structured index with links to raw markdown) --

// Build a short description for each page from its first non-heading paragraph
function extractBlurb(cleaned: string): string {
  const lines = cleaned.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('|') ||
      trimmed.startsWith('```') ||
      trimmed.startsWith('---')
    )
      continue
    // Strip markdown links/bold/code
    const plain = trimmed
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
    // Cap at ~120 chars
    return plain.length > 120 ? plain.slice(0, 117) + '...' : plain
  }
  return ''
}

const llmsSections: string[] = []
for (const { section, pages: urls } of NAV_ORDER) {
  const links: string[] = []
  for (const url of urls) {
    const page = pages.get(url)
    if (!page) continue
    const rawPath = `${url.replace(/^\//, '')}.md`
    const blurb = extractBlurb(page.cleaned)
    const desc = blurb ? `: ${blurb}` : ''
    links.push(`- [${page.title}](${BASE_URL}/raw/${rawPath})${desc}`)
  }
  if (links.length > 0) {
    llmsSections.push(`## ${section}\n\n${links.join('\n')}`)
  }
}

const llmsTxt =
  [
    `# Routecraft`,
    `> ${DESCRIPTION}`,
    `## Links\n\n${PROJECT_LINKS}`,
    ...llmsSections,
    `## Optional`,
    [
      `- [Full Documentation (single file)](${BASE_URL}/llms-full.txt): All documentation concatenated into one markdown file for bulk ingestion`,
      `- [Changelog](${BASE_URL}/raw/changelog.md)`,
    ].join('\n'),
  ].join('\n\n') + '\n'

const llmsPath = path.join(ROOT, 'public', 'llms.txt')
fs.writeFileSync(llmsPath, llmsTxt, 'utf8')

const pageCount = pages.size
const sizeKb = Math.round(Buffer.byteLength(combined) / 1024)
const nextSizeKb = Math.round(Buffer.byteLength(nextCombined) / 1024)
console.log(
  `Generated ${pageCount} raw markdown files, docs.md (${sizeKb} KB), llms.txt, and llms-full.txt in public/, ` +
    `plus ${nextPages.size} for the next channel with docs-next.md (${nextSizeKb} KB) and llms-full-next.txt`,
)
