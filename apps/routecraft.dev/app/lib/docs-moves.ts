import { pagesByChannel } from '@/lib/generated/docs-pages'
import type { DocsChannelName } from '@/lib/docs-channel'

/**
 * Docs pages that moved, old channel-relative route to new. A published URL
 * outlives our routing (inbound links, LLM caches), so a moved page answers
 * its old address with a 301 instead of a 404.
 */
const MOVED: Record<string, string> = {
  'reference/operations/suspend': 'reference/operations/defer',
  'advanced/expose-as-mcp': 'introduction/expose-to-an-agent',
  'advanced/talk-from-your-editor': 'introduction/talk-from-your-editor',
  'introduction/events': 'advanced/events',
  'introduction/tui': 'advanced/tui',
}

/** The old address of a moved page, when this channel still has it there. */
function earlierRoute(
  channel: DocsChannelName,
  route: string,
): string | undefined {
  const pages = pagesByChannel[channel] ?? []
  return Object.keys(MOVED).find(
    (old) => MOVED[old] === route && pages.includes(old),
  )
}

/** Where a moved page's request goes, and whether that holds for good. */
export interface DocsMove {
  route: string
  /**
   * True for old to new, which never reverses. A new address sent back to
   * the old one stops once the next release carries the page, and a cached
   * 301 there would loop against the forward redirect.
   */
  permanent: boolean
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
  const route = slug.replace(/\/$/, '')
  const forward = MOVED[route]
  if (forward && (pagesByChannel[channel] ?? []).includes(forward)) {
    return { route: forward, permanent: true }
  }
  const earlier = earlierRoute(channel, route)
  return earlier ? { route: earlier, permanent: false } : undefined
}

/** The HTTP status a move answers with. */
export function docsMoveStatus(move: DocsMove): 301 | 307 {
  return move.permanent ? 301 : 307
}

/**
 * The address a moved page still has on this channel, for a sidebar entry
 * whose href names its new one.
 *
 * The sidebar builds from main, so after a move it names the new address. The
 * released channel only has the old one until the next tag, and filtering the
 * entry out would leave a released page with no way in from the sidebar.
 */
export function earlierDocsHref(
  channel: DocsChannelName,
  href: string,
): string | undefined {
  const route = href.replace(/^\/docs\//, '').replace(/\/$/, '')
  const earlier = earlierRoute(channel, route)
  return earlier ? `/docs/${earlier}` : undefined
}

/**
 * A bare `/docs/...` href, pointed at the address the channel has for it.
 *
 * Pages that build from main (the blog, the changelog, the homepage) link
 * into whichever docs release the site was frozen to, and a moved page lives
 * at its old address before the release that moves it and at its new one
 * after. Resolving at render time lets an author write either address and get
 * a link that resolves in both. The fragment is dropped when the address
 * changes, because a heading on one side of a move is not promised on the
 * other.
 */
export function docsHrefOnChannel(
  channel: DocsChannelName,
  href: string,
): string {
  if (!href.startsWith('/docs/') || href.startsWith('/docs/next/')) return href
  const path = href.split('#')[0]
  const route = path.slice('/docs/'.length).replace(/\/$/, '')
  if ((pagesByChannel[channel] ?? []).includes(route)) return href
  const moved = movedDocsPage(channel, route)
  return moved ? `/docs/${moved.route}${path.endsWith('/') ? '/' : ''}` : href
}
