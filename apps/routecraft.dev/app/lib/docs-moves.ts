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

/**
 * Where a request for a missing page on this channel should go, if anywhere.
 *
 * Asked only when the channel has no page at `slug`, and answered only when it
 * has one at the destination. That is what makes a move safe across the
 * channel split: routes build from main, but `/docs` serves the last release,
 * which still carries the page at its old address until the next tag. A
 * redirect that fired unconditionally would shadow the released page, send its
 * readers to a 404 and fail the freeze gate.
 */
export function movedDocsPage(
  channel: DocsChannelName,
  slug: string,
): string | undefined {
  const target = MOVED[slug.replace(/\/$/, '')]
  if (!target) return undefined
  return (pagesByChannel[channel] ?? []).includes(target) ? target : undefined
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
  const pages = pagesByChannel[channel] ?? []
  const earlier = Object.keys(MOVED).find(
    (old) => MOVED[old] === route && pages.includes(old),
  )
  return earlier ? `/docs/${earlier}` : undefined
}
