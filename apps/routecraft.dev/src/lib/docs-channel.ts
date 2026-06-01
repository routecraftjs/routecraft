// The docs site serves multiple version channels under /docs. The released
// ("latest") channel has no extra path segment; in-development docs live under
// /docs/next, and historical majors, when they exist, under /docs/v{N}.
//
// These helpers let the shared docs shell render channel-relative links at
// runtime, driven purely by the current URL. One build therefore behaves
// correctly wherever a page is mounted: the same compiled Navigation renders
// /docs/... links on the latest channel and /docs/next/... links on the next
// channel, without a build-time prefix.

export const DOCS_ROOT = '/docs'

// A channel is addressed by an optional segment right after /docs.
const CHANNEL_SEGMENT = /^\/docs\/(next|v\d+)(?=\/|$)/

export interface DocsChannel {
  /** Display label, e.g. `v0.5.0` or `next`. */
  label: string
  /** URL prefix the channel is served under, e.g. `/docs` or `/docs/next`. */
  prefix: string
}

/** The channel prefix for a pathname, e.g. `/docs/next` or `/docs`. */
export function docsChannelPrefix(pathname: string): string {
  const match = pathname.match(CHANNEL_SEGMENT)
  return match ? `/docs/${match[1]}` : DOCS_ROOT
}

/**
 * Strip the channel segment so a path can be matched against the bare
 * `/docs/...` hrefs in the navigation config. `/docs/next/x` becomes `/docs/x`.
 */
export function stripDocsChannel(pathname: string): string {
  const match = pathname.match(CHANNEL_SEGMENT)
  if (!match) return pathname
  return `${DOCS_ROOT}${pathname.slice(`/docs/${match[1]}`.length)}`
}

/** Prepend a channel prefix to a bare `/docs/...` href. */
export function withDocsChannel(href: string, channelPrefix: string): string {
  if (channelPrefix === DOCS_ROOT) return href
  if (href === DOCS_ROOT) return channelPrefix
  if (href.startsWith(`${DOCS_ROOT}/`)) {
    return channelPrefix + href.slice(DOCS_ROOT.length)
  }
  return href
}

/**
 * The channels offered by the version switcher. The latest (released) channel
 * is always present; the in-development `next` channel is always built from the
 * main branch. Historical majors can be appended here once they are published.
 */
export function docsChannels(latestVersion: string): DocsChannel[] {
  return [
    { label: `v${latestVersion}`, prefix: DOCS_ROOT },
    { label: 'next', prefix: '/docs/next' },
  ]
}
