/**
 * Every page the build is expected to prerender.
 *
 * Shared by the Vite config, which hands the list to the prerenderer, and by
 * `verify-prerender`, which checks the list against what actually landed. A
 * verifier with its own copy of the list would pass while the build published
 * something else.
 *
 * The list is derived from the content tree rather than crawled, so a page
 * nothing links to is still published and a page that cannot render fails the
 * build instead of quietly disappearing. Deep links are pinned outside this
 * repository, so the trailing-slash form is part of the contract.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Pages that exist regardless of content, as trailing-slash URLs. */
const STATIC_PAGES = ['/', '/blog/', '/changelog/', '/cheat-sheet/']

/** Every authored page below a content root, as a trailing-slash URL. */
function contentRoutes(
  appDirectory: string,
  directory: string,
  prefix: string,
): string[] {
  const routes: string[] = []

  function walk(current: string, urlPath: string): void {
    // Unreadable is fatal rather than empty: swallowing it publishes a build
    // that succeeded with a whole channel missing from the prerender list.
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(current, entry.name), `${urlPath}/${entry.name}`)
      } else if (entry.name === 'index.mdx') {
        routes.push(`${urlPath}/`)
      }
    }
  }

  walk(join(appDirectory, 'content', directory), prefix)
  return routes
}

export function prerenderPages(appDirectory: string): string[] {
  return [
    ...STATIC_PAGES,
    ...contentRoutes(appDirectory, 'docs', '/docs'),
    ...contentRoutes(appDirectory, 'docs-next', '/docs/next'),
    ...contentRoutes(appDirectory, 'blog', '/blog'),
  ]
}
