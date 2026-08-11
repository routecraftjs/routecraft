/**
 * Fails on a broken internal link in the built site.
 *
 * Docs pages link to each other constantly and the two channels multiply every
 * mistake, so a moved or renamed page is easy to ship and hard to notice. This
 * walks the prerendered output rather than the source, which means it sees the
 * links exactly as a reader does: channel prefixes applied, redirects included,
 * and reference catalogues rendered.
 *
 * Usage: bun scripts/check-links.ts [output-dir]
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Glob } from 'bun'

import { PUBLIC_DIR } from './paths'

const outputDir = process.argv[2] ?? join(PUBLIC_DIR, '..', '.output', 'public')

/** Hosts that are this site under another name, so their paths are checkable. */
const SELF = /^https?:\/\/(www\.)?routecraft\.dev/

interface Link {
  href: string
  from: string
}

function pageUrl(file: string): string {
  const path = relative(outputDir, file).replace(/index\.html$/, '')
  return `/${path}`.replace(/\/+$/, '/')
}

const pages = new Map<string, string>()
const anchors = new Map<string, Set<string>>()
const links: Link[] = []

for (const file of new Glob('**/*.html').scanSync({
  cwd: outputDir,
  absolute: true,
})) {
  const html = readFileSync(file, 'utf8')
  const url = pageUrl(file)

  pages.set(url, html)
  anchors.set(
    url,
    new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])),
  )

  for (const match of html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
    links.push({ href: match[1], from: url })
  }
}

/** Static files are served straight from public, so a page match is not required. */
const assets = new Set(
  [...new Glob('**/*').scanSync({ cwd: outputDir })].map((path) => `/${path}`),
)

const broken: string[] = []
const seen = new Set<string>()

for (const { href, from } of links) {
  const decoded = href.replace(/&amp;/g, '&')
  const normalised = decoded.replace(SELF, '')

  if (!normalised.startsWith('/')) continue
  if (normalised.startsWith('//')) continue

  const [path, fragment] = normalised.split('#')
  const target = path === '' ? from : path
  const withSlash = target.endsWith('/') ? target : `${target}/`

  const key = `${from} -> ${normalised}`
  if (seen.has(key)) continue
  seen.add(key)

  const page = pages.get(withSlash) ?? pages.get(target)
  if (!page) {
    if (assets.has(target.replace(/^\//, '/'))) continue
    if (assets.has(target.slice(1))) continue
    broken.push(`${from}: no page at ${target}`)
    continue
  }

  if (!fragment) continue

  const targetUrl = pages.has(withSlash) ? withSlash : target
  if (!anchors.get(targetUrl)?.has(fragment)) {
    broken.push(`${from}: no anchor #${fragment} on ${targetUrl}`)
  }
}

if (broken.length > 0) {
  console.error(`Broken internal links (${broken.length}):`)
  for (const entry of broken.slice(0, 50)) console.error(`  ${entry}`)
  if (broken.length > 50) console.error(`  ... and ${broken.length - 50} more`)
  process.exit(1)
}

console.log(
  `Checked ${links.length} link(s) across ${pages.size} page(s); none broken.`,
)
