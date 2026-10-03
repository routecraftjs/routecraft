import { documentsHref } from '@/lib/docs-catalogue'
import type { DocsChannelName } from '@/lib/docs-channel'
import { earlierDocsHref } from '@/lib/docs-moves'
import { navigation } from '@/lib/navigation'

/**
 * The sidebar as one channel carries it.
 *
 * The config is shell, so it lists every page main knows about. An entry the
 * channel has no page for is dropped: on the released channel that is a page
 * written after the release, which would otherwise be a 404. A page that moved
 * since the release keeps its entry, pointed at the address the channel still
 * has. A section's own href gets the same test as its links, and a section
 * left with no links disappears.
 *
 * The sidebar and the previous/next links both read this, so the chain a
 * reader follows never reaches a page the sidebar would not show.
 */
export function navigationFor(channel: DocsChannelName) {
  return navigation
    .map((section) => ({
      ...section,
      href:
        section.href && documentsHref(channel, section.href)
          ? section.href
          : undefined,
      links: section.links.flatMap((link) => {
        if (documentsHref(channel, link.href)) return [link]
        const earlier = earlierDocsHref(channel, link.href)
        return earlier ? [{ ...link, href: earlier }] : []
      }),
    }))
    .filter((section) => section.links.length > 0)
}
