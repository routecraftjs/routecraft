/**
 * Decides which content files the example gate reads.
 *
 * The distinction that matters is authored against generated. `bun run
 * generate` writes `app/content/docs-next/` from the same pages this gate
 * already checks, so reading it would report every defect a second time
 * against a path nobody can edit and that only exists after a build. That is
 * why the gate passes on a clean checkout and fails once the site is built if
 * the exclusion is missing.
 */

import * as path from 'node:path'

import { Glob } from 'bun'

/** Top-level content directories written by the build rather than by hand. */
export const GENERATED_CONTENT = ['docs-next'] as const

/**
 * Whether a content-relative path belongs to a generated tree.
 *
 * @param relativePath Path relative to `app/content`, in either separator.
 */
export function isGeneratedContent(relativePath: string): boolean {
  const [top] = relativePath.split(/[\\/]/)
  return (GENERATED_CONTENT as readonly string[]).includes(top)
}

/** Absolute paths of every authored MDX page under the content directory. */
export function authoredMdxPaths(contentDir: string): string[] {
  return [...new Glob('**/*.mdx').scanSync(contentDir)]
    .filter((found) => !isGeneratedContent(found))
    .sort()
    .map((found) => path.join(contentDir, found))
}
