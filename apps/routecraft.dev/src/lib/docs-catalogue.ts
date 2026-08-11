// What each docs channel actually documents. The reference index components
// (operations, adapters, plugins, errors, events) live in the site shell, which
// always builds from main, while /docs is frozen to the last released tag on
// deploy. Asking the catalogue "does this channel document X" is what keeps an
// index from advertising unreleased API on the released channel, and from
// linking to a page that only exists on /docs/next.

import { type DocsChannelName } from '@/lib/docs-channel'
import { generatedDocsCatalogue } from '@/lib/docs-catalogue.generated'

const EMPTY = { pages: [] as string[], anchors: {} }

function catalogue(channel: DocsChannelName) {
  return generatedDocsCatalogue[channel] ?? EMPTY
}

/** Lookup key for an anchor: comparable across `RC1001`, `rc-1001`, `RC 1001`. */
function normaliseHeading(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Whether the channel has a page at a channel-relative route, e.g.
 * `reference/operations/split`.
 */
export function documentsPage(
  channel: DocsChannelName,
  route: string,
): boolean {
  return catalogue(channel).pages.includes(route)
}

/**
 * The anchor id a heading renders as on a page of this channel, or `undefined`
 * when the channel's copy of the page does not carry that heading. Resolving
 * rather than hand-building the anchor is what keeps `RC1001` pointing at the
 * `rc-1001` that Markdoc actually emits.
 */
export function resolveAnchor(
  channel: DocsChannelName,
  route: string,
  heading: string,
): string | undefined {
  return catalogue(channel).anchors[route]?.[normaliseHeading(heading)]
}
