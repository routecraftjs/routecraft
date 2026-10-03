import { channelHasPage, docsRoute } from '@/lib/docs-catalogue'
import type { DocsChannelName } from '@/lib/docs-channel'

/**
 * Docs pages that moved, old channel-relative route to new. A published URL
 * outlives our routing (inbound links, LLM caches), so a moved page answers
 * its old address with a redirect instead of a 404.
 */
const MOVED: Record<string, string> = {
  'reference/operations/suspend': 'reference/operations/defer',
  'advanced/expose-as-mcp': 'introduction/expose-to-an-agent',
  'advanced/talk-from-your-editor': 'introduction/talk-from-your-editor',
  'introduction/events': 'advanced/events',
  'introduction/tui': 'advanced/tui',
}

/** Where a moved page's request goes, and the status that sends it there. */
export interface DocsMove {
  route: string
  /**
   * 301 for old to new, which never reverses. 307 for a new address sent
   * back to the old one: that stops once the next release carries the page,
   * and a cached 301 there would loop against the forward redirect.
   */
  status: 301 | 307
}

/**
 * Where a request for a missing page on this channel should go, if anywhere.
 *
 * Asked only when the channel has no page at `slug`, and answered only with an
 * address the channel does have. That is what makes a move safe across the
 * channel split: routes build from main, but `/docs` serves the last release,
 * which keeps the page at its old address until the next tag. So an old
 * address redirects forward once the channel has the new page, and a new
 * address, already linked from READMEs and the blog, redirects back while the
 * channel only has the old one. A redirect that fired unconditionally would
 * shadow the released page and fail the freeze gate.
 */
export function movedDocsPage(
  channel: DocsChannelName,
  slug: string,
): DocsMove | undefined {
  const route = slug.replace(/\/+$/, '')
  const forward = MOVED[route]
  if (forward && channelHasPage(channel, forward)) {
    return { route: forward, status: 301 }
  }
  const earlier = Object.keys(MOVED).find(
    (old) => MOVED[old] === route && channelHasPage(channel, old),
  )
  return earlier ? { route: earlier, status: 307 } : undefined
}

/**
 * A bare `/docs/...` href, pointed at the address the channel has for it.
 *
 * Pages that build from main (the sidebar, the blog, the changelog, the
 * homepage) link into whichever docs release the site was frozen to, and a
 * moved page lives at its old address before the release that moves it and at
 * its new one after. Resolving at render time lets an author write either
 * address and get a link that resolves in both. The fragment is dropped when
 * the address changes, because a heading on one side of a move is not
 * promised on the other.
 */
export function docsHrefOnChannel(
  channel: DocsChannelName,
  href: string,
): string {
  if (!href.startsWith('/docs/') || href.startsWith('/docs/next/')) return href
  const route = docsRoute(href)
  if (channelHasPage(channel, route)) return href
  const moved = movedDocsPage(channel, route)
  return moved
    ? `/docs/${moved.route}${href.split('#')[0].endsWith('/') ? '/' : ''}`
    : href
}
