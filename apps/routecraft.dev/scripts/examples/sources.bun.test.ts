import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { authoredMdxPaths, isGeneratedContent } from './sources.ts'

const CONTENT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'app',
  'content',
)

describe('isGeneratedContent', () => {
  /**
   * @case The generated docs-next tree is recognised
   * @preconditions Path inside docs-next, which `bun run generate` writes from the authored pages
   * @expectedResult True, so the gate does not report every defect twice against a path nobody can edit
   */
  test('docs-next is generated', () => {
    expect(isGeneratedContent('docs-next/advanced/plugins/index.mdx')).toBe(
      true,
    )
  })

  /**
   * @case Authored trees are not mistaken for generated ones
   * @preconditions Paths inside docs, blog and changelog
   * @expectedResult False for each, so authored pages stay in scope
   */
  test('authored trees are kept', () => {
    expect(isGeneratedContent('docs/reference/adapters/json/index.mdx')).toBe(
      false,
    )
    expect(isGeneratedContent('blog/a-post/index.mdx')).toBe(false)
    expect(isGeneratedContent('changelog/index.mdx')).toBe(false)
  })

  /**
   * @case A directory merely starting with a generated name is not excluded
   * @preconditions Path under `docs-next-steps`, which is authored
   * @expectedResult False, because the match is on the whole path segment
   */
  test('the match is on a whole segment', () => {
    expect(isGeneratedContent('docs-next-steps/index.mdx')).toBe(false)
  })
})

describe('authoredMdxPaths', () => {
  /**
   * @case Discovery returns authored pages and never a generated one
   * @preconditions The repository's own content directory, which holds docs-next only after a build
   * @expectedResult Every returned path is absolute, ends in .mdx, and none sits under docs-next
   */
  test('generated pages are never returned', () => {
    const paths = authoredMdxPaths(CONTENT)

    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every((p) => path.isAbsolute(p) && p.endsWith('.mdx'))).toBe(
      true,
    )
    expect(
      paths.some((p) => p.includes(`${path.sep}docs-next${path.sep}`)),
    ).toBe(false)
  })
})
