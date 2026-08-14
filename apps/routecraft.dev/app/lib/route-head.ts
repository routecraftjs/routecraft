import type { PageHead } from '@/lib/page-head'

/**
 * Adapts a page's head description to what a TanStack Router `head()` returns.
 *
 * The title is a sibling of the meta list in `PageHead` but a meta entry to the
 * router, so it is folded in here rather than at every call site.
 */
export function toRouteHead(head: PageHead) {
  return {
    meta: [...(head.title ? [{ title: head.title }] : []), ...head.meta],
    links: head.links,
  }
}
