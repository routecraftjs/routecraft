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
): string | undefined {
  const route = slug.replace(/\/$/, '')
  const forward = MOVED[route]
  if (forward && (pagesByChannel[channel] ?? []).includes(forward)) {
    return forward
  }
  return earlierRoute(channel, route)
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
