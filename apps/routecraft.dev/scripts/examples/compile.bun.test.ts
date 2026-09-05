import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileBlocks, type BlockOutcome } from './compile.ts'
import type { BlockMarker, ExampleBlock } from './extract.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..', '..')
const REPO = path.resolve(APP, '..', '..')
// The work directory must sit inside the app so an example's `zod` import
// resolves the way the real run resolves it.
const WORK = path.join(APP, '.docs-typecheck-test')

afterAll(() => rmSync(WORK, { recursive: true, force: true }))

function block(
  code: string,
  marker: BlockMarker = { kind: 'check' },
): ExampleBlock {
  return {
    file: path.join(APP, 'app/content/docs/fixture/index.mdx'),
    fenceLine: 10,
    codeLine: 11,
    lang: 'ts',
    indent: 0,
    marker,
    code,
  }
}

function run(blocks: ExampleBlock[]): BlockOutcome[] {
  return compileBlocks(blocks, { repoRoot: REPO, workDir: WORK })
}

describe('compileBlocks', () => {
  const outcomes = run([
    block(
      "craft()\n  .id('ok')\n  .from(json({ path: './in.json' }))\n  .to(log())",
    ),
    block(
      "craft()\n  .id('bad')\n  .from(json({ file: './in.json' }))\n  .to(log())",
    ),
    block('this is not typescript at all !!!', {
      kind: 'skip',
      reason: 'fragment: prose',
    }),
    block("craft().from(json({ file: './in.json' }))", {
      kind: 'expect-error',
      reason: 'json() takes path, not file',
    }),
    block('const a: number = 1\nconsole.log(a)', {
      kind: 'expect-error',
      reason: 'this actually compiles',
    }),
    block(
      "craft()\n  .id('events')\n  .from(event('route:error'))\n  .to(log())",
    ),
    block(
      "craft()\n  .id('outgrown')\n  .from(json({ path: './in.json' }))\n  .to(log())",
      { kind: 'skip', reason: 'fragment: this block has outgrown its excuse' },
    ),
  ])

  /**
   * @case A block naming package exports without importing them still compiles
   * @preconditions Block uses craft, json and log with no import statement
   * @expectedResult Outcome is ok, because the imports are synthesised from the packages' exports
   */
  test('missing imports are synthesised', () => {
    expect(outcomes[0].status).toBe('ok')
    expect(outcomes[0].diagnostics).toEqual([])
  })

  /**
   * @case An option name the adapter does not accept fails the block
   * @preconditions json() is called with `file`, the defect class PR #722 corrected, where the real option is `path`
   * @expectedResult Outcome is failed and a diagnostic names the unknown property
   */
  test('an unknown adapter option fails', () => {
    expect(outcomes[1].status).toBe('failed')
    expect(outcomes[1].diagnostics.map((d) => d.message).join(' ')).toContain(
      "'file' does not exist",
    )
  })

  /**
   * @case A failing block reports the documentation file, not the generated one
   * @preconditions Block came from a fixture .mdx whose code starts at line 11
   * @expectedResult Diagnostic carries the .mdx path and a line at or after the block's first line
   */
  test('diagnostics point at the source file and line', () => {
    const [diagnostic] = outcomes[1].diagnostics

    expect(diagnostic.file).toEndWith('app/content/docs/fixture/index.mdx')
    expect(diagnostic.line).toBeGreaterThanOrEqual(11)
    expect(diagnostic.line).toBeLessThanOrEqual(14)
  })

  /**
   * @case A skipped block is never compiled
   * @preconditions Block is not TypeScript at all and carries a skip marker
   * @expectedResult Outcome is skipped with no diagnostics, so the marker genuinely excludes it
   */
  test('a skip marker excludes the block from compilation', () => {
    const skipped = outcomes.find((o) => o.status === 'skipped')

    expect(skipped).toBeDefined()
    expect(skipped?.diagnostics).toEqual([])
  })

  /**
   * @case A block marked expect-error that does not compile passes
   * @preconditions Block calls json() with the wrong option and is marked expect-error
   * @expectedResult Outcome is ok, because the block failed as the marker promised
   */
  test('expect-error passes when the block fails', () => {
    expect(outcomes[3].status).toBe('ok')
  })

  /**
   * @case A block marked expect-error that compiles is a failure
   * @preconditions Block is valid TypeScript but claims to be an error
   * @expectedResult Outcome is unexpectedly-compiled, so a page cannot go on teaching an error that is not one
   */
  test('expect-error fails when the block compiles', () => {
    expect(outcomes[4].status).toBe('unexpectedly-compiled')
  })

  /**
   * @case A block marked skip that in fact compiles is reported
   * @preconditions A complete, valid route carrying a skip marker
   * @expectedResult Outcome is skip-unnecessary, so a marker carried forward through a rewrite cannot silently stop a block being checked
   */
  test('a skip marker that is no longer earned is reported', () => {
    expect(outcomes[6].status).toBe('skip-unnecessary')
  })

  /**
   * @case A package export is not masked by a DOM global of the same name
   * @preconditions Block calls event(), which lib.dom also declares as a Window property
   * @expectedResult Outcome is ok, proving event() resolved to the adapter rather than to Window.event
   */
  test('a DOM global does not mask a package export', () => {
    expect(outcomes[5].status).toBe('ok')
  })
})

describe('module augmentation', () => {
  // Three TypeScript programs: the export map, then the shared and isolated
  // passes. Each carries the whole of `packages/*` and the lib files, which the
  // source cache parses once but still binds per program. That is about three
  // seconds here, and Bun's default budget is five, too thin a margin to leave
  // to whichever machine runs CI.
  /**
   * @case One block's module augmentation does not validate another block's code
   * @preconditions One block augments StoreRegistry with 'leaked'; a separate block calls store('leaked') without augmenting anything
   * @expectedResult The second block fails, because an augmentation on one page must not silently make another page's example valid
   */
  test('an augmentation does not leak into another block', () => {
    const [augmenting, consumer] = run([
      block(
        "declare module '@routecraft/routecraft' {\n" +
          '  interface StoreRegistry {\n' +
          '    leaked: number\n' +
          '  }\n' +
          '}',
      ),
      block("const context = new ContextBuilder()\ncontext.store('leaked', 1)"),
    ])

    expect(augmenting.status).toBe('ok')
    expect(consumer.status).toBe('failed')
    expect(consumer.diagnostics.map((d) => d.message).join(' ')).toContain(
      'StoreRegistry',
    )
  }, 20_000)
})
