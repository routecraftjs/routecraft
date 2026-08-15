#!/usr/bin/env bun

/**
 * Fails the build when a page the prerenderer was asked for did not land.
 *
 * The prerenderer serves the built site over HTTP and crawls it. When it cannot
 * reach that server every request fails, but the failures surface as unhandled
 * rejections rather than a non-zero exit, so the build reports success and ships
 * `.output` with no page HTML in it. That happened inside the release image: a
 * green run pushed a container that had prerendered nothing, and nothing between
 * the build and the registry noticed.
 *
 * The generated assets are not checked here. `bun run generate` writes them
 * before the build and fails loudly on its own.
 *
 * Run as: bun scripts/verify-prerender.ts
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { prerenderPages } from './prerender-pages'

const appRoot = resolve(import.meta.dirname, '..')
const publicDir = join(appRoot, '.output', 'public')

if (!existsSync(publicDir)) {
  console.error(`No build output at ${publicDir}. Did the build run?`)
  process.exit(1)
}

const expected = prerenderPages(join(appRoot, 'app'))

/** Where the prerenderer writes a page: `/docs/x/` becomes `docs/x/index.html`. */
function htmlPath(page: string): string {
  return join(publicDir, page.replace(/^\/|\/$/g, ''), 'index.html')
}

const missing = expected.filter((page) => !existsSync(htmlPath(page)))

if (missing.length > 0) {
  console.error(
    `Prerender produced ${expected.length - missing.length} of ${expected.length} pages.`,
  )
  console.error(`Missing (${missing.length}):`)
  for (const page of missing.slice(0, 20)) console.error(`  ${page}`)
  if (missing.length > 20)
    console.error(`  ... and ${missing.length - 20} more`)
  process.exit(1)
}

console.log(`Prerendered all ${expected.length} expected pages.`)
