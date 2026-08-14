/**
 * The framework-neutral description of a page's `<head>`.
 *
 * Metadata is derived from content (post frontmatter, doc frontmatter) rather
 * than written per route, so it is produced by plain functions and consumed by
 * a router `head()`. Keeping the shape free of router types means the same
 * builders can be called from a prerender script or a feed generator.
 *
 * `title` is optional: a page that leaves it unset keeps whatever title the
 * surrounding shell set, which is how an unpublished post falls back to the
 * site title instead of announcing itself.
 */
export interface PageHead {
  title?: string
  meta: PageHeadMeta[]
  links: PageHeadLink[]
}

/** A `<meta>` tag, keyed by `name` (document metadata) or `property` (OpenGraph). */
export interface PageHeadMeta {
  name?: string
  property?: string
  content: string
}

/** A `<link>` tag, e.g. the canonical URL. */
export interface PageHeadLink {
  rel: string
  href: string
}

/**
 * Drop the entries a page does not carry, so builders can list every tag they
 * might emit in one literal instead of pushing conditionally.
 */
export function compactMeta(
  entries: Array<PageHeadMeta | null | undefined>,
): PageHeadMeta[] {
  return entries.filter((entry): entry is PageHeadMeta => Boolean(entry))
}
