#!/usr/bin/env node

/**
 * Asserts that the built site publishes exactly the released docs, and fails
 * the deploy when it does not.
 *
 * Every version-pinning bug this repo has had was a drift between what the
 * freeze was believed to do and what the artifact actually contained: a
 * `git checkout <tag> -- <path>` that added the tag's pages without removing
 * anything, and row data that lived outside the pinned tree. Prose in a
 * workflow comment did not catch either. This does, by comparing the exported
 * routes against the tag itself, so the next freeze-shaped mistake stops the
 * deploy instead of shipping.
 *
 * Checks, against `out/` after `next build`:
 *   1. the released channel's docs routes match the freeze tag's page set
 *      exactly (no page added after the release, none dropped);
 *   2. the in-development channel is present, so a broken next snapshot is
 *      caught rather than silently published as an empty channel;
 *   3. no /docs/next URL leaks into the sitemap (that channel is noindex).
 *
 * Skipped when no freeze tag is in play (a working-tree deploy before the
 * first freezable release), since there is nothing to compare against.
 *
 * Run as: node --experimental-strip-types scripts/verify-docs-freeze.mjs <freeze-tag>
 */

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import glob from 'fast-glob'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'out')
const APP_DOCS = 'apps/routecraft.dev/src/app/docs'

const freezeTag = process.argv[2]

if (!freezeTag) {
  console.log(
    'No freeze tag given; the released channel is publishing from the working tree. Nothing to verify.',
  )
  process.exit(0)
}

if (!fs.existsSync(OUT_DIR)) {
  throw new Error(`No build output at ${OUT_DIR}. Run the build first.`)
}

// The one deliberate exception. The changelog moved to a top-level /changelog
// on the main cadence, and the freeze restores main's redirect stub at the old
// /docs/changelog URL on purpose (it is a page.tsx, so it is not in either
// channel's page.md set). Excluded from both sides of the comparison rather
// than special-cased in the diff, so the exception is stated once.
const isMainCadenceRoute = (route) =>
  route === 'changelog' || route.startsWith('changelog/')

/** Docs routes the tag documents, as channel-relative paths. */
function routesAtTag(tag) {
  const listing = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', tag, '--', APP_DOCS],
    { encoding: 'utf8', cwd: path.resolve(ROOT, '..', '..') },
  )
  return new Set(
    listing
      .split('\n')
      .filter((file) => file.endsWith('/page.md'))
      .map((file) => {
        // path.dirname('page.md') is '.', but the built landing page is the
        // empty route. Left unnormalised, a tag carrying docs/page.md would be
        // reported as missing on every deploy.
        const relative = file.slice(`${APP_DOCS}/`.length)
        return relative === 'page.md' ? '' : path.dirname(relative)
      })
      .filter((route) => !isMainCadenceRoute(route)),
  )
}

/** Docs routes the build actually emitted, split by channel. */
function routesInBuild() {
  const latest = new Set()
  const next = new Set()

  for (const file of glob.sync('docs/**/index.html', { cwd: OUT_DIR })) {
    const route = path.dirname(file).slice('docs/'.length)
    if (route === '.') continue
    if (route === 'next' || route.startsWith('next/')) {
      next.add(route.slice('next'.length).replace(/^\//, ''))
    } else if (!isMainCadenceRoute(route)) {
      latest.add(route)
    }
  }

  return { latest, next }
}

const expected = routesAtTag(freezeTag)
const { latest, next } = routesInBuild()

const problems = []

const leaked = [...latest].filter((route) => !expected.has(route)).sort()
if (leaked.length > 0) {
  problems.push(
    `${leaked.length} route(s) published on /docs that ${freezeTag} does not document:\n` +
      leaked.map((route) => `    /docs/${route}`).join('\n'),
  )
}

const missing = [...expected].filter((route) => !latest.has(route)).sort()
if (missing.length > 0) {
  problems.push(
    `${missing.length} route(s) documented by ${freezeTag} but missing from /docs:\n` +
      missing.map((route) => `    /docs/${route}`).join('\n'),
  )
}

if (next.size === 0) {
  problems.push(
    'The /docs/next channel is empty. The next snapshot is taken from main before the ' +
      'freeze; an empty channel means that step did not run or was overwritten.',
  )
}

const sitemap = path.join(OUT_DIR, 'sitemap.xml')
if (fs.existsSync(sitemap)) {
  const urls = fs.readFileSync(sitemap, 'utf8').match(/\/docs\/next\//g) ?? []
  if (urls.length > 0) {
    problems.push(
      `The sitemap lists ${urls.length} /docs/next URL(s); the in-development channel is noindex ` +
        'and must not be submitted to crawlers.',
    )
  }
}

if (problems.length > 0) {
  console.error(
    `\nThe published docs do not match ${freezeTag}:\n\n` +
      problems.map((problem) => `  - ${problem}`).join('\n\n') +
      '\n',
  )
  process.exit(1)
}

console.log(
  `Verified: /docs publishes exactly the ${expected.size} page(s) ${freezeTag} documents, ` +
    `/docs/next carries ${next.size}, and no next URL is in the sitemap.`,
)
