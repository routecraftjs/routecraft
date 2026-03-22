#!/usr/bin/env node

/**
 * Generates clean markdown files in public/raw/ for each docs page
 * and a combined all-docs file at public/raw/docs.md.
 *
 * Run as: node --experimental-strip-types scripts/generate-raw-docs.mjs
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import glob from 'fast-glob'
import { cleanMarkdoc } from '../src/lib/clean-markdoc.mjs'
import { navigation } from '../src/lib/navigation.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const APP_DIR = path.join(ROOT, 'src', 'app')
const OUT_DIR = path.join(ROOT, 'public', 'raw')

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
  '/docs/changelog',
  ...navigation
    .map((s) => s.href)
    .filter((href) => href !== '/' && href !== '/docs/introduction'),
])

function extractTitle(md) {
  const match = md.match(/^---[\s\S]*?---/)
  if (!match) return undefined
  const titleMatch = match[0].match(/^title:\s*(.+)$/m)
  return titleMatch
    ? titleMatch[1].trim().replace(/^["']|["']$/g, '')
    : undefined
}

// Build a map of url -> { title, cleaned markdown }
const pages = new Map()

const files = glob.sync('**/page.md', { cwd: APP_DIR }).sort()
for (const file of files) {
  const url = file === 'page.md' ? '/' : `/${file.replace(/\/page\.md$/, '')}`
  const md = fs.readFileSync(path.join(APP_DIR, file), 'utf8')
  const title = extractTitle(md)
  const cleaned = cleanMarkdoc(md, title)
  pages.set(url, { title, cleaned })
}

// Write individual page files
for (const [url, { cleaned }] of pages) {
  const relPath = url === '/' ? 'index.md' : `${url.replace(/^\//, '')}.md`
  const outPath = path.join(OUT_DIR, relPath)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, cleaned, 'utf8')
}

// Write combined docs.md in navigation order, skipping excluded pages
const parts = []
const seen = new Set()
for (const { section, pages: urls } of NAV_ORDER) {
  const sectionPages = urls.filter((u) => !SKIP_IN_COMBINED.has(u))
  if (sectionPages.length === 0) continue
  parts.push(`# ${section}\n`)
  for (const url of sectionPages) {
    if (seen.has(url)) continue
    seen.add(url)
    const page = pages.get(url)
    if (!page) continue
    parts.push(page.cleaned)
  }
}
// Include any pages not in navigation (excluding root and skipped)
for (const [url, { cleaned }] of pages) {
  if (url === '/' || seen.has(url) || SKIP_IN_COMBINED.has(url)) continue
  parts.push(cleaned)
}

let combined = parts.join('\n')

// Token-reduction passes for LLM consumption:
// 1. Remove duplicate consecutive H1 headings (section title + page title)
combined = combined.replace(/^(# .+)\n\n# .+$/gm, '$1')
// 2. Strip image lines (LLMs cannot see images)
combined = combined.replace(/^!\[.*?\]\(.*?\)\n?/gm, '')
// 3. Keep only pnpm install blocks, strip npm/yarn/bun variants
combined = combined.replace(
  /\*\*(?:npm|yarn|bun):?\*\*:?\n```\w*\n.*?\n```\n?/gs,
  '',
)
// 4. Collapse whitespace
combined = combined.replace(/\n{3,}/g, '\n\n').trim() + '\n'

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
  `- npm: [@routecraft/browser](https://www.npmjs.com/package/@routecraft/browser)`,
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

// -- Generate llms.txt (structured index with links to raw markdown) --

// Build a short description for each page from its first non-heading paragraph
function extractBlurb(cleaned) {
  const lines = cleaned.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('|') ||
      trimmed.startsWith('```') ||
      trimmed.startsWith('---') ||
      trimmed.startsWith('{%')
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

const llmsSections = []
for (const { section, pages: urls } of NAV_ORDER) {
  const links = []
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
      `- [Changelog](${BASE_URL}/raw/docs/changelog.md)`,
    ].join('\n'),
  ].join('\n\n') + '\n'

const llmsPath = path.join(ROOT, 'public', 'llms.txt')
fs.writeFileSync(llmsPath, llmsTxt, 'utf8')

const pageCount = pages.size
const sizeKb = Math.round(Buffer.byteLength(combined) / 1024)
console.log(
  `Generated ${pageCount} raw markdown files, docs.md (${sizeKb} KB), llms.txt, and llms-full.txt in public/`,
)
