/**
 * The docs page registry, one entry per authored MDX file, per channel.
 *
 * Both channels are resolved from globs at build time, so there is no
 * request-time content resolution in production and the prerender can
 * enumerate every page from the same source the router reads.
 *
 * The channel comes from the route that owns the glob, never from the content.
 * That is what lets the next-channel snapshot be a verbatim copy of the
 * released tree rather than a regex-marked variant of it.
 */

import type { ComponentType } from 'react'
import type { TocEntry } from './mdx-plugins'
import type { DocsChannelName } from './docs-channel'

export interface DocsFrontmatter {
  title?: string
  nav?: string
  description?: string
  layout?: string
}

export interface DocsModule {
  default: ComponentType
  frontmatter?: DocsFrontmatter
  toc?: TocEntry[]
  /** Names of components on the page that contribute their own outline. */
  outlines?: string[]
}

export interface DocsPage {
  /** Path below the channel root, without leading or trailing slash. */
  slug: string
  module: DocsModule
}

const RELEASED = import.meta.glob<DocsModule>('../content/docs/**/index.mdx', {
  eager: true,
})

const NEXT = import.meta.glob<DocsModule>('../content/docs-next/**/index.mdx', {
  eager: true,
})

function toRegistry(
  modules: Record<string, DocsModule>,
  root: string,
): Map<string, DocsPage> {
  const pages = new Map<string, DocsPage>()

  for (const [path, module] of Object.entries(modules)) {
    const slug = path
      .slice(path.indexOf(root) + root.length)
      .replace(/\/index\.mdx$/, '')
      .replace(/^\//, '')

    pages.set(slug, { slug, module })
  }

  return pages
}

const REGISTRIES: Record<DocsChannelName, Map<string, DocsPage>> = {
  latest: toRegistry(RELEASED, '/content/docs'),
  next: toRegistry(NEXT, '/content/docs-next'),
}

export function docsPage(
  channel: DocsChannelName,
  slug: string,
): DocsPage | undefined {
  return REGISTRIES[channel].get(slug.replace(/^\/+|\/+$/g, ''))
}

export function docsPages(channel: DocsChannelName): DocsPage[] {
  return [...REGISTRIES[channel].values()]
}
