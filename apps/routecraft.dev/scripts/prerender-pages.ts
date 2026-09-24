import { readdirSync } from 'node:fs'
import { join } from 'node:path'

// Extension included: vite.config.ts imports this module, and Vite's native
// config loader does not resolve extensionless relative imports.
import { CONTENT_DIR } from './paths.ts'

/**
 * Every authored page below a content root, as a trailing-slash URL.
 *
 * Derived from the content tree rather than crawled, so a page nothing links
 * to is still published. Deep links are pinned outside this repository, so the
 * trailing-slash form is part of the contract.
 */
function contentRoutes(directory: string, prefix: string): string[] {
  const routes: string[] = []

  function walk(current: string, urlPath: string): void {
    // Unreadable is fatal rather than empty: swallowing it publishes a build
    // that succeeded with a whole channel missing from the prerender list.
    const entries = readdirSync(current, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(current, entry.name), `${urlPath}/${entry.name}`)
      } else if (entry.name === 'index.mdx') {
        routes.push(`${urlPath}/`)
      }
    }
  }

  walk(join(CONTENT_DIR, directory), prefix)
  return routes
}

/**
 * The pages the build prerenders, and therefore the pages
 * `verify-prerender.ts` requires in the output. One list, so the two cannot
 * disagree about what a complete build is.
 */
export function prerenderPages(): string[] {
  return [
    '/',
    '/blog/',
    '/changelog/',
    '/cheat-sheet/',
    ...contentRoutes('docs', '/docs'),
    ...contentRoutes('docs-next', '/docs/next'),
    ...contentRoutes('blog', '/blog'),
  ]
}
