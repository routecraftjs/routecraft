#!/usr/bin/env node

/**
 * Materialises the in-development docs channel at src/app/docs/next/ by copying
 * every docs page.md (except the next channel itself) and rewriting internal
 * /docs/... links to /docs/next/... so a reader stays within the channel.
 *
 * The output is gitignored and rebuilt on each prebuild. It is filesystem
 * routing, so the copies become real /docs/next/** routes; their noindex +
 * canonical-to-latest metadata is supplied by the route shims via docMetadata.
 *
 * In CI the channel is generated from the main working tree *before* /docs is
 * frozen to the latest release tag, then the build runs with SKIP_DOCS_NEXT=1
 * so this script does not overwrite that snapshot with the frozen content.
 *
 * Run as: node --experimental-strip-types scripts/generate-docs-next.mjs
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import glob from 'fast-glob'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DOCS_DIR = path.join(ROOT, 'src', 'app', 'docs')
const NEXT_DIR = path.join(DOCS_DIR, 'next')

// Docs-referenced assets live outside the docs tree, so they are pinned by the
// release freeze listing them explicitly; the next channel gets its own mirror
// under <dir>/next so one build can serve both.
const SCREENSHOTS_DIR_NAME = 'screenshots'
const SCREENSHOTS_DIR = path.join(ROOT, 'public', SCREENSHOTS_DIR_NAME)

if (process.env.SKIP_DOCS_NEXT && fs.existsSync(NEXT_DIR)) {
  console.log(
    'SKIP_DOCS_NEXT set and docs/next exists; leaving snapshot as-is.',
  )
  process.exit(0)
}

// Rewrite absolute /docs/... links to /docs/next/... in markdown and Markdoc
// tag attributes. Links that already target the next channel are skipped via a
// negative lookahead so they are not doubled to /docs/next/next: "next" followed
// by a segment or delimiter boundary (slash, closing paren/quote, query, hash)
// is the channel, whereas a sibling page like /docs/next-steps (next followed by
// "-") is still rewritten. Links to /changelog are outside /docs and untouched.
function rewriteLinks(md) {
  return (
    md
      .replace(/\]\(\/docs\/(?!next(?:[/)#?]|$))/g, '](/docs/next/')
      .replace(/href="\/docs\/(?!next(?:["/#?]|$))/g, 'href="/docs/next/')
      .replace(/href='\/docs\/(?!next(?:['/#?]|$))/g, "href='/docs/next/")
      // Screenshots are versioned content: a screenshot reshot for unreleased
      // UI would otherwise redraw the released page, since public/ is shell.
      // The released copies are frozen with the docs and the next channel reads
      // its own, mirrored below.
      .replace(/\/screenshots\/(?!next\/)/g, `/${SCREENSHOTS_DIR_NAME}/next/`)
  )
}

// The reference index tags render catalogues that must match the channel they
// are read on, but the components behind them live in the site shell and always
// build from main. Tagging the copy tells them which channel they are on; see
// src/markdoc/tags.js and src/lib/docs-catalogue.ts.
const CHANNEL_TAGS = [
  'adapter-grid',
  'operations-index',
  'plugin-index',
  'error-table',
  'event-namespaces',
]

function markChannel(md) {
  return md.replace(
    new RegExp(`\\{%\\s*(${CHANNEL_TAGS.join('|')})\\b`, 'g'),
    '{% $1 channel="next"',
  )
}

fs.rmSync(NEXT_DIR, { recursive: true, force: true })

const files = glob
  .sync('**/page.md', { cwd: DOCS_DIR })
  .filter((file) => !file.startsWith('next/'))

let count = 0
for (const file of files) {
  const src = path.join(DOCS_DIR, file)
  const dest = path.join(NEXT_DIR, file)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(
    dest,
    markChannel(rewriteLinks(fs.readFileSync(src, 'utf8'))),
    'utf8',
  )
  count++
}

// The reference row data is versioned content too: it sits under docs/ so the
// release freeze pins it to the released tag, which means the next channel
// needs its own copy of main's. See scripts/generate-docs-catalogue.mjs.
const DATA_DIR = path.join(DOCS_DIR, '_data')
let dataCount = 0
if (fs.existsSync(DATA_DIR)) {
  for (const file of glob.sync('*.json', { cwd: DATA_DIR })) {
    const dest = path.join(NEXT_DIR, '_data', file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(DATA_DIR, file), dest)
    dataCount++
  }
}

// Mirror the docs screenshots for the next channel (see rewriteLinks).
const SCREENSHOTS_NEXT_DIR = path.join(SCREENSHOTS_DIR, 'next')
fs.rmSync(SCREENSHOTS_NEXT_DIR, { recursive: true, force: true })
let assetCount = 0
if (fs.existsSync(SCREENSHOTS_DIR)) {
  for (const file of glob.sync('**/*', {
    cwd: SCREENSHOTS_DIR,
    onlyFiles: true,
    ignore: ['next/**'],
  })) {
    const dest = path.join(SCREENSHOTS_NEXT_DIR, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(SCREENSHOTS_DIR, file), dest)
    assetCount++
  }
}

console.log(
  `Generated ${count} page(s), ${dataCount} data file(s) and ${assetCount} asset(s) for the next docs channel.`,
)
