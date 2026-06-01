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

if (process.env.SKIP_DOCS_NEXT && fs.existsSync(NEXT_DIR)) {
  console.log(
    'SKIP_DOCS_NEXT set and docs/next exists; leaving snapshot as-is.',
  )
  process.exit(0)
}

// Rewrite absolute /docs/... links to /docs/next/... in markdown and Markdoc
// tag attributes. Links to /changelog (shared, unversioned) are left untouched.
function rewriteLinks(md) {
  return md
    .replaceAll('](/docs/', '](/docs/next/')
    .replaceAll('href="/docs/', 'href="/docs/next/')
    .replaceAll("href='/docs/", "href='/docs/next/")
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
  fs.writeFileSync(dest, rewriteLinks(fs.readFileSync(src, 'utf8')), 'utf8')
  count++
}

console.log(`Generated ${count} page(s) for the next docs channel.`)
