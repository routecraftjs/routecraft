/**
 * Pins the released docs channel to a git tag, in the working tree.
 *
 * `/docs` publishes the last released version and `/docs/next` publishes main.
 * The freeze is source level: the versioned paths are wiped and checked out
 * from the tag, with the next-channel snapshot preserved across the swap. The
 * release workflow runs this before building, and a developer runs it to
 * reproduce a production build locally.
 *
 * TRANSITIONAL: tags cut before the TanStack Start migration carry Markdoc
 * content at the old paths. Those are converted on the fly by
 * `convert-markdoc.ts` so the site can build from them unchanged. Delete
 * `freezeLegacyTag` and the Markdoc dependency once the oldest tag the release
 * workflow will freeze ships MDX, which is the same condition that retires the
 * `fallbackRows` path in generate-docs-catalogue.
 *
 * Usage:
 *   bun scripts/freeze-docs.ts <tag>     pin the tree to a tag
 *   bun scripts/freeze-docs.ts --restore undo, returning to the checked-out ref
 */

import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, cp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The pinned set, and the only pinned set. It must stay in step with the path
 * list in `.github/workflows/release.yml` and the one named in
 * `.standards/content-and-docs.md`; they are one list.
 */
const PINNED = [
  'apps/routecraft.dev/app/content/docs',
  'apps/routecraft.dev/app/content/cheat-sheet',
  'apps/routecraft.dev/public/screenshots',
]

/** Content that belongs to main and must survive the swap. */
const PRESERVED = [
  'apps/routecraft.dev/app/content/docs-next',
  'apps/routecraft.dev/public/screenshots/next',
]

/** Where a pre-migration tag kept the same content. */
const LEGACY = {
  docs: 'apps/routecraft.dev/src/app/docs',
  screenshots: 'apps/routecraft.dev/public/screenshots',
}

const REPO_ROOT = join(import.meta.dir, '../../..')

/**
 * Records which tag the content root holds.
 *
 * The build reads it to say out loud which channel is publishing what. Without
 * it an unfrozen local image looks exactly like a release build while serving
 * main on `/docs`. It lives inside the frozen path, so restoring clears it.
 */
const MARKER = join(REPO_ROOT, 'apps/routecraft.dev/app/content/docs/.frozen')

async function tagCarries(tag: string, path: string): Promise<boolean> {
  const result =
    await $`git -C ${REPO_ROOT} ls-tree -d --name-only ${tag} -- ${path}`
      .quiet()
      .nothrow()
  return result.exitCode === 0 && result.stdout.toString().trim() !== ''
}

async function checkout(tag: string, paths: string[]): Promise<void> {
  await $`git -C ${REPO_ROOT} checkout ${tag} -- ${paths}`.quiet()
}

/** Freezes a tag that already ships the MDX content root. */
async function freezeModernTag(tag: string): Promise<void> {
  for (const path of PINNED) {
    await rm(join(REPO_ROOT, path), { recursive: true, force: true })
  }
  const present = []
  for (const path of PINNED) {
    if (await tagCarries(tag, path)) present.push(path)
  }
  await checkout(tag, present)
}

/**
 * Freezes a tag that predates the migration by converting its Markdoc content.
 *
 * The tag is checked out into a scratch worktree rather than over the working
 * tree, because its layout no longer matches this one and a partial checkout
 * would strand files the new build would then serve.
 */
async function freezeLegacyTag(tag: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'routecraft-freeze-'))

  try {
    await $`git -C ${REPO_ROOT} worktree add --detach ${scratch} ${tag}`.quiet()

    // The cheat sheet is deliberately left on main's copy here. A pre-migration
    // tag carries it as a Next page component this stack cannot render, so
    // wiping it would delete the only usable version and break the build.
    // Holding cheat-sheet edits until the first post-migration tag is the
    // matching discipline, recorded in MIGRATION.md.
    for (const path of PINNED) {
      if (path.endsWith('/cheat-sheet')) continue
      await rm(join(REPO_ROOT, path), { recursive: true, force: true })
    }

    const legacyDocs = join(scratch, LEGACY.docs)
    if (!existsSync(legacyDocs)) {
      throw new Error(
        `tag ${tag} carries neither the MDX nor the Markdoc docs root`,
      )
    }

    await $`bun ${join(import.meta.dir, 'convert-markdoc.ts')} ${legacyDocs} ${join(REPO_ROOT, 'apps/routecraft.dev/app/content/docs')}`

    const legacyData = join(legacyDocs, '_data')
    if (existsSync(legacyData)) {
      await cp(
        legacyData,
        join(REPO_ROOT, 'apps/routecraft.dev/app/content/docs/_data'),
        { recursive: true },
      )
    }

    const legacyScreenshots = join(scratch, LEGACY.screenshots)
    if (existsSync(legacyScreenshots)) {
      await cp(
        legacyScreenshots,
        join(REPO_ROOT, 'apps/routecraft.dev/public/screenshots'),
        { recursive: true },
      )
    }

    console.log(
      `Converted Markdoc content from ${tag}; delete freezeLegacyTag once no such tag is freezable.`,
    )
  } finally {
    await $`git -C ${REPO_ROOT} worktree remove --force ${scratch}`
      .quiet()
      .nothrow()
  }
}

async function freeze(tag: string): Promise<void> {
  const parked = await mkdtemp(join(tmpdir(), 'routecraft-next-'))
  const saved: Array<{ from: string; to: string }> = []

  for (const path of PRESERVED) {
    const source = join(REPO_ROOT, path)
    if (!existsSync(source)) continue
    const target = join(parked, path.replaceAll('/', '_'))
    await cp(source, target, { recursive: true })
    saved.push({ from: target, to: source })
  }

  const modern = await tagCarries(tag, 'apps/routecraft.dev/app/content/docs')
  if (modern) await freezeModernTag(tag)
  else await freezeLegacyTag(tag)

  for (const { from, to } of saved) {
    await rm(to, { recursive: true, force: true })
    await cp(from, to, { recursive: true })
  }

  await rm(parked, { recursive: true, force: true })
  await writeFile(MARKER, `${tag}\n`)

  console.log(`Froze the released docs channel to ${tag}.`)
}

async function restore(): Promise<void> {
  for (const path of PINNED) {
    await rm(join(REPO_ROOT, path), { recursive: true, force: true })
  }
  await $`git -C ${REPO_ROOT} checkout HEAD -- ${PINNED}`.quiet().nothrow()
  console.log('Restored the versioned paths from HEAD.')
}

const argument = process.argv[2]

if (!argument) {
  console.error(
    'Usage: bun scripts/freeze-docs.ts <tag> | bun scripts/freeze-docs.ts --restore',
  )
  process.exit(1)
}

if (argument === '--restore') await restore()
else await freeze(argument)
