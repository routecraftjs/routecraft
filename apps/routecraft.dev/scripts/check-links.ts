/**
 * Fails on a broken internal link in the built site.
 *
 * Docs pages link to each other constantly and the two channels multiply every
 * mistake, so a moved or renamed page is easy to ship and hard to notice. This
 * walks the prerendered output rather than the source, which means it sees the
 * links exactly as a reader does: channel prefixes applied, redirects included,
 * and reference catalogues rendered.
 *
 * A frozen released channel is a special case. `/docs` publishes a git tag, so
 * a link broken in that tag cannot be fixed without cutting a new release, and
 * failing the deploy over it would block every future deploy on history. Pass
 * the freeze tag and those become warnings; the next channel, which is main,
 * always fails.
 *
 * Usage: bun scripts/check-links.ts [--freeze-tag <tag>] [output-dir]
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Glob } from 'bun'

import { PUBLIC_DIR } from './paths'

const args = process.argv.slice(2)
const tagIndex = args.indexOf('--freeze-tag')
const freezeTag = tagIndex === -1 ? undefined : args[tagIndex + 1]
const positional = args.filter(
  (value, index) => index !== tagIndex && index !== tagIndex + 1,
)
const outputDir = positional[0] ?? join(PUBLIC_DIR, '..', '.output', 'public')

/** True for a page published from the frozen tag rather than from main. */
function isFrozen(url: string): boolean {
  return (
    freezeTag !== undefined &&
    url.startsWith('/docs/') &&
    !url.startsWith('/docs/next/')
  )
}

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
const frozen: string[] = []
const seen = new Set<string>()

function report(from: string, message: string): void {
  ;(isFrozen(from) ? frozen : broken).push(`${from}: ${message}`)
}

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
    report(from, `no page at ${target}`)
    continue
  }

  if (!fragment) continue

  const targetUrl = pages.has(withSlash) ? withSlash : target
  if (!anchors.get(targetUrl)?.has(fragment)) {
    report(from, `no anchor #${fragment} on ${targetUrl}`)
  }
}

if (frozen.length > 0) {
  console.warn(
    `Broken links inside the frozen ${freezeTag} docs (${frozen.length}), fixable only by a new release:`,
  )
  for (const entry of frozen.slice(0, 20)) console.warn(`  ${entry}`)
}

if (broken.length > 0) {
  console.error(`Broken internal links (${broken.length}):`)
  for (const entry of broken.slice(0, 50)) console.error(`  ${entry}`)
  if (broken.length > 50) console.error(`  ... and ${broken.length - 50} more`)
  process.exit(1)
}

console.log(
  `Checked ${links.length} link(s) across ${pages.size} page(s); none broken${
    frozen.length > 0 ? ` outside the frozen ${freezeTag} docs` : ''
  }.`,
)
