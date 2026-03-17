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
    .replace(/\n---\s*$/, '')
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
