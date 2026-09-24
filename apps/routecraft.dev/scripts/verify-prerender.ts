#!/usr/bin/env bun

/**
 * Fails when any page the build was asked to prerender is missing from the
 * output.
 *
 * TanStack Start's prerender reports a page that fails to render as an
 * unhandled rejection and still exits 0, so a build where every page returned
 * 500 looks green and publishes an empty site. This check is what turns that
 * into a failed build.
 *
 * Run as: bun scripts/verify-prerender.ts
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { OUTPUT_PUBLIC_DIR } from './paths'
import { prerenderPages } from './prerender-pages'

const pages = prerenderPages()
const missing = pages.filter(
  (page) => !existsSync(join(OUTPUT_PUBLIC_DIR, page, 'index.html')),
)

if (missing.length > 0) {
  const shown = missing.slice(0, 20).map((page) => `  ${page}`)
  if (missing.length > shown.length) {
    shown.push(`  ... and ${missing.length - shown.length} more`)
  }
  console.error(
    `Prerender incomplete: ${missing.length} of ${pages.length} pages missing ` +
      `from ${OUTPUT_PUBLIC_DIR}. The render errors are in the build log above.\n` +
      shown.join('\n'),
  )
  process.exit(1)
}

console.log(`Prerender complete: ${pages.length} pages.`)
