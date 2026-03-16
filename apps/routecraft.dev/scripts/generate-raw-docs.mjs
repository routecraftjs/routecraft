#!/usr/bin/env node

/**
 * Generates clean markdown files in public/raw/ for each docs page
 * and a combined all-docs file at public/raw/docs.md.
 *
 * Run as: node scripts/generate-raw-docs.mjs
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import glob from 'fast-glob'
import { cleanMarkdoc } from '../src/lib/clean-markdoc.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const APP_DIR = path.join(ROOT, 'src', 'app')
const OUT_DIR = path.join(ROOT, 'public', 'raw')

// Navigation order (matches src/lib/navigation.ts)
const NAV_ORDER = [
  { section: 'Getting Started', pages: ['/', '/docs/changelog'] },
  {
    section: 'Introduction',
    pages: [
      '/docs/introduction',
      '/docs/introduction/installation',
      '/docs/introduction/project-structure',
      '/docs/introduction/capabilities',
      '/docs/introduction/exchange',
      '/docs/introduction/operations',
      '/docs/introduction/adapters',
    ],
  },
  {
    section: 'Advanced',
    pages: [
      '/docs/advanced/plugins',
      '/docs/introduction/events',
      '/docs/advanced/composing-capabilities',
      '/docs/advanced/error-handling',
      '/docs/advanced/custom-adapters',
      '/docs/advanced/expose-as-mcp',
      '/docs/advanced/call-an-mcp',
      '/docs/advanced/linting',
      '/docs/introduction/testing',
      '/docs/introduction/deployment',
      '/docs/introduction/monitoring',
    ],
  },
  {
    section: 'Reference',
    pages: [
      '/docs/reference/adapters',
      '/docs/reference/operations',
      '/docs/reference/events',
      '/docs/reference/configuration',
      '/docs/reference/cli',
      '/docs/reference/plugins',
      '/docs/reference/linting',
      '/docs/reference/errors',
    ],
  },
  {
    section: 'Examples',
    pages: ['/docs/examples', '/docs/examples/api-sync'],
  },
  {
    section: 'Community',
    pages: [
      '/docs/community',
      '/docs/community/contribution-guide',
      '/docs/community/faq',
    ],
  },
]

function extractTitle(md) {
  const match = md.match(/^---[\s\S]*?---/)
  if (!match) return undefined
  const titleMatch = match[0].match(/^title:\s*(.+)$/m)
  return titleMatch
    ? titleMatch[1].trim().replace(/^["']|["']$/g, '')
    : undefined
}

function urlToFilePath(url) {
  if (url === '/') return path.join(APP_DIR, 'page.md')
  return path.join(APP_DIR, url.replace(/^\//, ''), 'page.md')
}

// Build a map of url -> { title, cleaned markdown }
const pages = new Map()

const files = glob.sync('**/page.md', { cwd: APP_DIR })
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

// Write combined docs.md in navigation order
const parts = []
const seen = new Set()
for (const { section, pages: urls } of NAV_ORDER) {
  parts.push(`# ${section}\n`)
  for (const url of urls) {
    if (seen.has(url)) continue
    seen.add(url)
    const page = pages.get(url)
    if (!page) continue
    parts.push(page.cleaned)
    parts.push('\n---\n')
  }
}
// Include any pages not in navigation
for (const [url, { cleaned }] of pages) {
  if (!seen.has(url)) {
    parts.push(cleaned)
    parts.push('\n---\n')
  }
}

const combined =
  parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n'
const docsPath = path.join(OUT_DIR, 'docs.md')
fs.mkdirSync(path.dirname(docsPath), { recursive: true })
fs.writeFileSync(docsPath, combined, 'utf8')

const pageCount = pages.size
const sizeKb = Math.round(Buffer.byteLength(combined) / 1024)
console.log(
  `Generated ${pageCount} raw markdown files and docs.md (${sizeKb} KB) in public/raw/`,
)
