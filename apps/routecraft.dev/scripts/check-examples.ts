/**
 * Compiles the TypeScript examples in the documentation and fails the build
 * when one does not typecheck.
 *
 * The pages here are the ones a new user copies from, and nothing else in the
 * repository reads them as code: a fenced block is prose to every other check,
 * so an example naming an option that does not exist survives review and
 * ships. This closes that gap.
 *
 * A block that is not meant to compile says so on its fence, with a reason:
 *
 *     ```ts skip="fragment: dest is illustrative"
 *     ```ts expect-error="json() takes path, not file"
 *
 * A block with no marker must compile.
 *
 * Usage:
 *
 *     bun run check:examples
 */

import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import { CONTENT_DIR, ROOT } from './paths.ts'
import { compileBlocks, type BlockOutcome } from './examples/compile.ts'
import { authoredMdxPaths } from './examples/sources.ts'
import {
  extractCheatCode,
  extractFences,
  isTypeScript,
  MarkerError,
  type ExampleBlock,
} from './examples/extract.ts'

const REPO_ROOT = path.resolve(ROOT, '..', '..')
const WORK_DIR = path.join(ROOT, '.docs-typecheck')
const CHEAT_SHEET = path.join(CONTENT_DIR, 'cheat-sheet', 'CheatSheet.tsx')

function relative(file: string): string {
  return path.relative(REPO_ROOT, file)
}

function collect(): ExampleBlock[] {
  const blocks: ExampleBlock[] = []

  for (const file of authoredMdxPaths(CONTENT_DIR)) {
    blocks.push(...extractFences(file, readFileSync(file, 'utf8')))
  }
  blocks.push(
    ...extractCheatCode(CHEAT_SHEET, readFileSync(CHEAT_SHEET, 'utf8')),
  )

  return blocks.filter((block) => isTypeScript(block.lang))
}

function reportFailures(failures: BlockOutcome[]): void {
  const byFile = new Map<string, BlockOutcome[]>()
  for (const failure of failures) {
    const bucket = byFile.get(failure.block.file)
    if (bucket) bucket.push(failure)
    else byFile.set(failure.block.file, [failure])
  }

  for (const [file, items] of [...byFile].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.error(`\n${relative(file)}`)
    for (const item of items.sort(
      (a, b) => a.block.fenceLine - b.block.fenceLine,
    )) {
      if (
        item.status === 'unexpectedly-compiled' ||
        item.status === 'skip-unnecessary'
      ) {
        const { marker } = item.block
        const reason = marker.kind === 'check' ? '' : marker.reason
        console.error(
          item.status === 'unexpectedly-compiled'
            ? `  line ${item.block.fenceLine}: marked expect-error, but it compiles.\n` +
                `    The reason given was: ${reason}\n` +
                '    Either the example was fixed, in which case drop the marker, or the\n' +
                '    API changed and the page now teaches an error that is not one.'
            : `  line ${item.block.fenceLine}: marked skip, but it compiles.\n` +
                `    The reason given was: ${reason}\n` +
                '    The block has outgrown its excuse. Drop the marker so it stays checked.',
        )
        continue
      }
      for (const d of item.diagnostics) {
        console.error(
          `  ${relative(d.file)}:${d.line}:${d.column}  TS${d.code}: ${d.message}`,
        )
      }
    }
  }
}

function main(): number {
  const started = Date.now()

  let blocks: ExampleBlock[]
  try {
    blocks = collect()
  } catch (error) {
    if (error instanceof MarkerError) {
      console.error(`${relative(error.file)}:${error.line}  ${error.message}`)
      return 1
    }
    throw error
  }

  const outcomes = compileBlocks(blocks, {
    repoRoot: REPO_ROOT,
    workDir: WORK_DIR,
  })
  const failures = outcomes.filter(
    (o) =>
      o.status === 'failed' ||
      o.status === 'unexpectedly-compiled' ||
      o.status === 'skip-unnecessary',
  )

  reportFailures(failures)

  const compiled = outcomes.filter((o) => o.status === 'ok').length
  const skipped = outcomes.filter((o) => o.status === 'skipped').length

  console.error(
    `\n${compiled} compiled, ${skipped} skipped, ${failures.length} failed`,
  )

  if (failures.length) {
    console.error(
      '\nA block that cannot compile needs a marker on its fence saying why:' +
        '\n  ```ts skip="fragment: dest is illustrative"' +
        '\n  ```ts expect-error="json() takes path, not file"',
    )
  }

  console.error(`took ${((Date.now() - started) / 1000).toFixed(1)}s`)

  return failures.length ? 1 : 0
}

process.exit(main())
