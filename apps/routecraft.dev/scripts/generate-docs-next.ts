/**
 * Materialises the in-development docs channel at app/content/docs-next/ by
 * copying every docs page and its reference data.
 *
 * The copy is verbatim. A page no longer carries its channel: the route that
 * loads it does, and internal /docs/... links are made channel-aware at render
 * time by the MDX provider through `withDocsChannel` (app/lib/docs-channel.ts).
 * So there is nothing left to rewrite on the way through.
 *
 * The output is gitignored and rebuilt on each prebuild.
 *
 * A frozen docs tree is never a valid source: copying it would publish the
 * released docs on both channels. `scripts/freeze-docs.ts` takes the snapshot
 * from main before it pins `/docs`, and leaves the `.frozen` marker this script
 * reads, so the decision travels with the content rather than with an
 * environment variable the caller has to remember.
 *
 * Run as: bun scripts/generate-docs-next.ts
 */

import { copyFile, mkdir, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Glob } from 'bun'

const ROOT = resolve(import.meta.dirname, '..')
const DOCS_DIR = join(ROOT, 'app', 'content', 'docs')
const NEXT_DIR = join(ROOT, 'app', 'content', 'docs-next')

// Docs-referenced assets live outside the content tree, so they are pinned by
// the release freeze listing them explicitly; the next channel gets its own
// mirror under <dir>/next so one build can serve both. Screenshots are
// versioned content: a screenshot reshot for unreleased UI would otherwise
// redraw the released page, since public/ is shell.
const SCREENSHOTS_DIR = join(ROOT, 'public', 'screenshots')
const SCREENSHOTS_NEXT_DIR = join(SCREENSHOTS_DIR, 'next')

/**
 * Which release `/docs` is pinned to, if it is pinned at all.
 *
 * The marker lives inside the frozen path, so restoring the tree clears it.
 */
const MARKER = join(DOCS_DIR, '.frozen')
const frozenTag = existsSync(MARKER)
  ? readFileSync(MARKER, 'utf8').trim()
  : undefined

if (frozenTag) {
  if (!existsSync(NEXT_DIR)) {
    throw new Error(
      `/docs is frozen to ${frozenTag}, so it cannot be the source of the ` +
        'next channel, and no snapshot of main was found at ' +
        `${NEXT_DIR}. Restore the tree and freeze again: freeze-docs.ts takes ` +
        'the snapshot before it pins the released channel.',
    )
  }

  console.log(
    `Released channel is frozen to ${frozenTag}; keeping the next-channel ` +
      'snapshot taken from main.',
  )
  process.exit(0)
}

async function filesIn(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for await (const file of new Glob('**/*').scan({ cwd: dir })) {
    files.push(file)
  }
  return files.sort()
}

async function mirror(
  sourceDir: string,
  targetDir: string,
  files: string[],
): Promise<void> {
  for (const file of files) {
    const target = join(targetDir, file)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(sourceDir, file), target)
  }
}

await rm(NEXT_DIR, { recursive: true, force: true })

const docsFiles = await filesIn(DOCS_DIR)
await mirror(DOCS_DIR, NEXT_DIR, docsFiles)

const pageCount = docsFiles.filter((file) => file.endsWith('.mdx')).length
// The reference row data is versioned content too: it sits under the docs tree
// so the release freeze pins it to the released tag, which means the next
// channel needs its own copy of main's. See scripts/generate-docs-catalogue.ts.
const dataCount = docsFiles.filter((file) => file.startsWith('_data/')).length

await rm(SCREENSHOTS_NEXT_DIR, { recursive: true, force: true })
const assets = await filesIn(SCREENSHOTS_DIR)
await mirror(SCREENSHOTS_DIR, SCREENSHOTS_NEXT_DIR, assets)

console.log(
  `Generated ${pageCount} page(s), ${dataCount} data file(s) and ` +
    `${assets.length} asset(s) for the next docs channel.`,
)

// An unfrozen build serves main on /docs, which looks identical to a release
// build until you notice unreleased pages on the released channel. Saying it
// out loud is cheaper than discovering it in an image.
console.log(
  'Released channel is NOT frozen: /docs will publish main, same as ' +
    '/docs/next. Run scripts/freeze-docs.ts <tag> to reproduce a release build.',
)
