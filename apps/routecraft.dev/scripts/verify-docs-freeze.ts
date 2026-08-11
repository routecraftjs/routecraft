/**
 * Asserts that the built site publishes exactly the released docs, and fails
 * the deploy when it does not.
 *
 * Every version-pinning bug this repo has had was a drift between what the
 * freeze was believed to do and what the artifact actually contained: a
 * `git checkout <tag> -- <path>` that added the tag's pages without removing
 * anything, and row data that lived outside the pinned tree. Prose in a
 * workflow comment did not catch either. This does, by comparing the prerender
 * output against the tag itself, so the next freeze-shaped mistake stops the
 * deploy instead of shipping.
 *
 * Checks, against `.output/public` after the build:
 *   1. the released channel's docs routes match the freeze tag's page set
 *      exactly (no page added after the release, none dropped);
 *   2. the in-development channel is present, so a broken next snapshot is
 *      caught rather than silently published as an empty channel;
 *   3. no /docs/next URL leaks into the sitemap (that channel is noindex).
 *
 * Skipped when no freeze tag is in play (a working-tree deploy before the
 * first freezable release), since there is nothing to compare against.
 *
 * TRANSITIONAL: a tag cut before the content root moved carries Markdoc
 * `page.md` under `src/app/docs`, which `freeze-docs.ts` converts to the MDX
 * tree the build reads. Its page set is read from whichever layout the tag
 * carries; drop `LEGACY_ROOT` when `freezeLegacyTag` goes.
 *
 * Run as: bun scripts/verify-docs-freeze.ts <freeze-tag>
 */

import { $ } from 'bun'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(ROOT, '..', '..')
const PUBLIC_DIR = join(ROOT, '.output', 'public')

/** Where the tag keeps its docs pages, newest layout first. */
const CONTENT_ROOT = {
  path: 'apps/routecraft.dev/app/content/docs',
  page: 'index.mdx',
}
const LEGACY_ROOT = {
  path: 'apps/routecraft.dev/src/app/docs',
  page: 'page.md',
}

const freezeTag = process.argv[2]

if (!freezeTag) {
  console.log(
    'No freeze tag given; the released channel is publishing from the working tree. Nothing to verify.',
  )
  process.exit(0)
}

if (!existsSync(PUBLIC_DIR)) {
  throw new Error(`No prerender output at ${PUBLIC_DIR}. Run the build first.`)
}

// The one deliberate exception. The changelog is published at a top-level
// /changelog on the main cadence, and a pre-migration tag still carries a page
// for it under the docs tree. Excluded from both sides of the comparison rather
// than special-cased in the diff, so the exception is stated once.
const isMainCadenceRoute = (route: string): boolean =>
  route === 'changelog' || route.startsWith('changelog/')

/** Every file the tag carries below a path, repository-relative. */
async function filesAtTag(tag: string, path: string): Promise<string[]> {
  const listing =
    await $`git -C ${REPO_ROOT} ls-tree -r --name-only ${tag} -- ${path}`
      .quiet()
      .nothrow()

  if (listing.exitCode !== 0) return []

  return listing.stdout.toString().split('\n').filter(Boolean)
}

/** Docs routes the tag documents, as channel-relative paths. */
async function routesAtTag(tag: string): Promise<Set<string>> {
  for (const root of [CONTENT_ROOT, LEGACY_ROOT]) {
    const pages = (await filesAtTag(tag, root.path)).filter((file) =>
      file.endsWith(`/${root.page}`),
    )

    if (pages.length === 0) continue

    return new Set(
      pages
        .map((file) => {
          // The landing page of a channel is the empty route. Left
          // unnormalised, a tag carrying a docs root page would be reported as
          // missing on every deploy.
          const relative = file.slice(`${root.path}/`.length)
          return relative === root.page ? '' : dirname(relative)
        })
        .filter((route) => !isMainCadenceRoute(route)),
    )
  }

  throw new Error(
    `${tag} carries no docs pages at ${CONTENT_ROOT.path} or ${LEGACY_ROOT.path}.`,
  )
}

/** Docs routes the build actually emitted, split by channel. */
function routesInBuild(): { latest: Set<string>; next: Set<string> } {
  const latest = new Set<string>()
  const next = new Set<string>()
  const docsDir = join(PUBLIC_DIR, 'docs')

  if (!existsSync(docsDir)) return { latest, next }

  const pages = readdirSync(docsDir, {
    recursive: true,
    encoding: 'utf8',
  }).filter((file) => file === 'index.html' || file.endsWith('/index.html'))

  for (const file of pages) {
    const route = file === 'index.html' ? '' : dirname(file)
    if (route === 'next' || route.startsWith('next/')) {
      next.add(route.slice('next'.length).replace(/^\//, ''))
    } else if (!isMainCadenceRoute(route)) {
      latest.add(route)
    }
  }

  return { latest, next }
}

const expected = await routesAtTag(freezeTag)
const { latest, next } = routesInBuild()

const problems: string[] = []

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

const sitemap = join(PUBLIC_DIR, 'sitemap.xml')
if (existsSync(sitemap)) {
  const urls = readFileSync(sitemap, 'utf8').match(/\/docs\/next\//g) ?? []
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
