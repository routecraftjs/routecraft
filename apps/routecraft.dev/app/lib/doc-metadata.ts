import { documentsHref } from '@/lib/docs-catalogue'
import { headsByChannel } from '@/lib/generated/docs-heads'
import { compactMeta, type PageHead } from '@/lib/page-head'
import { absoluteUrl, canonicalPath, siteName } from '@/lib/site'

// Per-doc metadata, read from the page's frontmatter and lead paragraph at
// build time. A route addresses the same file the router renders, so the title
// a page advertises and the title it shows come from one source.

function isNextRoute(route: string): boolean {
  return route === 'next' || route.startsWith('next/')
}

/**
 * The title and description the page advertises.
 *
 * Comes from the catalogue generated at build time rather than from the source
 * tree: the deployed image ships `.output` alone, so a read of `app/content`
 * here answers for nothing and every docs page falls back to its raw slug.
 */
function readDocHead(route: string): { title: string; description?: string } {
  const channel = isNextRoute(route) ? 'next' : 'latest'
  const key = isNextRoute(route) ? route.replace(/^next\/?/, '') : route
  return headsByChannel[channel][key] ?? { title: route }
}

export function docMetadata(route: string): PageHead {
  const { title, description } = readDocHead(route)
  // The in-development /docs/next channel mirrors the latest docs. It is kept
  // out of search indexes and canonicalises to its latest-channel equivalent so
  // engines consolidate on the released page rather than the preview.
  const isNext = isNextRoute(route)
  const latestRoute = isNext ? route.replace(/^next\/?/, '') : route
  const latestHref = latestRoute ? `/docs/${latestRoute}` : '/docs'
  // A page that only exists on the next channel documents unreleased API, so
  // it has no released equivalent to consolidate on; pointing at one would
  // canonicalise to a URL that 404s. Those pages canonicalise to themselves.
  const canonicalHref =
    isNext && !documentsHref('latest', latestHref)
      ? `/docs/${route}`
      : latestHref
  const url = absoluteUrl(canonicalPath(canonicalHref))
  // Absolute title: the docs shell sets a title of its own and a page title is
  // not composed from its ancestors, so spell the full one out here.
  const fullTitle = `${title} · Docs - ${siteName}`
  return {
    title: fullTitle,
    meta: compactMeta([
      description ? { name: 'description', content: description } : null,
      isNext ? { name: 'robots', content: 'noindex, follow' } : null,
      { property: 'og:title', content: fullTitle },
      description ? { property: 'og:description', content: description } : null,
      { property: 'og:url', content: url },
      { property: 'og:type', content: 'article' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: fullTitle },
      description
        ? { name: 'twitter:description', content: description }
        : null,
    ]),
    links: [{ rel: 'canonical', href: url }],
  }
}
