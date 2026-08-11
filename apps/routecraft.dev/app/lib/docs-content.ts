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

import { lazy } from 'react'
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

/**
 * Page modules are imported lazily so each page compiles to its own chunk.
 *
 * Eagerly globbing the tree put all 242 pages into one bundle that every docs
 * page then downloaded, which the Next build never did.
 */
const RELEASED = import.meta.glob<DocsModule>('../content/docs/**/index.mdx')
const NEXT = import.meta.glob<DocsModule>('../content/docs-next/**/index.mdx')

type Loader = () => Promise<DocsModule>

function toRegistry(
  modules: Record<string, Loader>,
  root: string,
): Map<string, Loader> {
  const pages = new Map<string, Loader>()

  for (const [path, loader] of Object.entries(modules)) {
    const slug = path
      .slice(path.indexOf(root) + root.length)
      .replace(/\/index\.mdx$/, '')
      .replace(/^\//, '')

    pages.set(slug, loader)
  }

  return pages
}

const REGISTRIES: Record<DocsChannelName, Map<string, Loader>> = {
  latest: toRegistry(RELEASED, '/content/docs'),
  next: toRegistry(NEXT, '/content/docs-next'),
}

function normalise(slug: string): string {
  return slug.replace(/^\/+|\/+$/g, '')
}

const RESOLVED = new Map<string, DocsModule>()

function cacheKey(channel: DocsChannelName, slug: string): string {
  return `${channel}:${slug}`
}

/**
 * One lazy component per page, built once at module scope.
 *
 * Creating them during render would hand React a new component type on every
 * pass and reset the page's state. Wrapping a loader costs nothing until the
 * component is actually rendered, which is when its chunk is fetched.
 */
const LAZY: Map<string, ComponentType> = new Map(
  (['latest', 'next'] as const).flatMap((channel) =>
    [...REGISTRIES[channel].entries()].map(
      ([slug, loader]) =>
        [
          cacheKey(channel, slug),
          lazy(async () => ({ default: (await loader()).default })),
        ] as const,
    ),
  ),
)

/**
 * Loads a page module, for the route loader.
 *
 * Awaiting it there means the import is already resolved by the time the
 * component suspends on it, so the server renders the content into the shell
 * rather than streaming it in after the fact.
 */
export async function loadDocsPage(
  channel: DocsChannelName,
  slug: string,
): Promise<DocsModule | undefined> {
  const key = normalise(slug)
  const cached = RESOLVED.get(cacheKey(channel, key))
  if (cached) return cached

  const loader = REGISTRIES[channel].get(key)
  if (!loader) return undefined

  const loaded = await loader()
  RESOLVED.set(cacheKey(channel, key), loaded)
  return loaded
}

/**
 * The page's content component.
 *
 * Deliberately lazy rather than read from the resolved cache: loaders do not
 * re-run on hydration, so the browser has to fetch the page's own chunk. That
 * chunk is the point of splitting the content tree in the first place.
 */
export function docsComponent(
  channel: DocsChannelName,
  slug: string,
): ComponentType | undefined {
  return LAZY.get(cacheKey(channel, normalise(slug)))
}

export function docsPageSlugs(channel: DocsChannelName): string[] {
  return [...REGISTRIES[channel].keys()]
}
