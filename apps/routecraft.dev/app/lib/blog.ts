import path from 'node:path'

import { parseFrontmatter } from '@/lib/frontmatter'
import { formatBlogDate } from '@/lib/blog-date'

// Re-exported so existing server-side importers of `@/lib/blog` keep working.
export { formatBlogDate }

export interface BlogPostMeta {
  slug: string
  title: string
  description?: string
  date: string
  /**
   * Optional last-updated date (YYYY-MM-DD). Drives `dateModified`,
   * `article:modified_time`, and the sitemap's `lastmod`. Bump it only when a
   * post's content materially changes; it falls back to `date` when absent.
   * Kept explicit rather than derived from file mtime so a fresh CI checkout
   * (which resets every file's mtime to build time) can't fake freshness.
   */
  updated?: string
  author?: string
  authorRole?: string
  authorAvatar?: string
  tags?: string[]
  /** Routecraft version the post was written for / verified against. */
  version?: string
  featured?: boolean
  /** Pin this post as the homepage pick, independent of dates. One post should carry it. */
  home?: boolean
  draft?: boolean
  image?: string
  imageAlt?: string
  /** Override the auto-picked cover glyph. First character only. */
  coverGlyph?: string
  /**
   * Id of the post's lead figure (see `@/components/figures`). Its motif
   * becomes the cover artwork on the post hero, the index card, the home
   * teaser, and the OG image.
   */
  diagram?: string
  /** Explicit follow-up posts (slugs); overrides the tag-based suggestions. */
  related?: string[]
  /**
   * Absolute URL of the canonical publication when this post is a cross-post
   * of an article whose home is elsewhere (e.g. devoptix.nl). Drives the
   * canonical link tag, `og:url`, JSON-LD `mainEntityOfPage`, the sitemap
   * exclusion, and the visible attribution line on the post page. Mirrors the
   * same field in the devoptix.nl blog frontmatter, pointing the other way.
   */
  canonical?: string
  readingTime: number
  href: string
}

const WORDS_PER_MINUTE = 220

function estimateReadingTime(body: string): number {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\{%[\s\S]*?%\}/g, ' ')
    .replace(/[#*_`>\-]/g, ' ')
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE))
}

// Coerce a frontmatter date value (js-yaml gives us a Date for bare `2026-01-02`
// and a string for a quoted one) to a `YYYY-MM-DD` string.
function toDateString(value: unknown): string | undefined {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : typeof value === 'string'
      ? value
      : undefined
}

/**
 * Post sources, resolved by the bundler rather than from disk.
 *
 * The blog index, sitemap, feed and home page all read posts, and they render
 * in both the server and the browser bundle, where a filesystem read is not
 * available.
 */
const SOURCES: Record<string, string> = import.meta.glob(
  '../content/blog/**/index.mdx',
  {
    eager: true,
    query: '?raw',
    import: 'default',
  },
)

const BY_SLUG = new Map<string, string>(
  Object.entries(SOURCES).map(([file, source]) => [
    file.replace(/.*\/content\/blog\//, '').replace(/\/index\.mdx$/, ''),
    source,
  ]),
)

function readPost(slug: string): BlogPostMeta | undefined {
  const md = BY_SLUG.get(slug)
  if (md === undefined) return undefined
  const { data, body } = parseFrontmatter(md)
  if (data.published === false) return undefined

  const date = toDateString(data.date) ?? ''
  const updated = toDateString(data.updated)

  return {
    slug,
    title: typeof data.title === 'string' ? data.title : slug,
    description:
      typeof data.description === 'string' ? data.description : undefined,
    date,
    updated,
    author: typeof data.author === 'string' ? data.author : undefined,
    authorRole:
      typeof data.authorRole === 'string' ? data.authorRole : undefined,
    authorAvatar:
      typeof data.authorAvatar === 'string' ? data.authorAvatar : undefined,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : undefined,
    version: typeof data.version === 'string' ? data.version : undefined,
    featured: data.featured === true,
    home: data.home === true,
    draft: data.draft === true,
    image: typeof data.image === 'string' ? data.image : undefined,
    imageAlt: typeof data.imageAlt === 'string' ? data.imageAlt : undefined,
    coverGlyph:
      typeof data.coverGlyph === 'string' ? data.coverGlyph : undefined,
    diagram: typeof data.diagram === 'string' ? data.diagram : undefined,
    related: Array.isArray(data.related) ? data.related.map(String) : undefined,
    canonical:
      typeof data.canonical === 'string' && /^https?:\/\//.test(data.canonical)
        ? data.canonical
        : undefined,
    readingTime:
      typeof data.readingTime === 'number'
        ? data.readingTime
        : estimateReadingTime(body),
    href: `/blog/${slug}/`,
  }
}

let cachedPosts: BlogPostMeta[] | null = null

export function getAllBlogPosts(): BlogPostMeta[] {
  // Content is frozen in a production build and this is called repeatedly by
  // the sitemap, the feed, the blog index and the OG images. In dev the cache
  // is skipped so edits to a post hot-reload.
  if (cachedPosts && import.meta.env.PROD) return cachedPosts
  const posts: BlogPostMeta[] = []
  for (const slug of BY_SLUG.keys()) {
    const post = readPost(slug)
    if (post) posts.push(post)
  }
  posts.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  cachedPosts = posts
  return posts
}

/**
 * Posts safe to expose publicly (drafts excluded). The single definition of
 * "publicly visible" shared by the sitemap, RSS feed, blog index, and OG image
 * numbering, so those surfaces cannot drift on which posts are discoverable.
 */
export function getPublishedPosts(
  posts: BlogPostMeta[] = getAllBlogPosts(),
): BlogPostMeta[] {
  return posts.filter((p) => !p.draft)
}

/**
 * A post's effective last-modified date (`YYYY-MM-DD`): `updated` when the
 * author set it, otherwise the publish `date`. One definition of the freshness
 * policy so `dateModified`, `article:modified_time`, and the sitemap's `lastmod`
 * cannot disagree for the same post.
 */
export function lastModifiedDate(post: BlogPostMeta): string {
  return post.updated ?? post.date
}

export function getFeaturedPost(
  posts: BlogPostMeta[] = getAllBlogPosts(),
): BlogPostMeta | undefined {
  return (
    posts.find((p) => p.home && !p.draft) ??
    posts.find((p) => p.featured && !p.draft) ??
    posts.find((p) => !p.draft) ??
    posts[0]
  )
}

/**
 * Suggested follow-up posts for a given post. An explicit `related` list in the
 * post's frontmatter wins (author's order, unknown slugs dropped); otherwise the
 * posts sharing the most tags are returned, most recent breaking ties. Drafts
 * and the post itself are never suggested.
 */
export function getRelatedPosts(
  current: BlogPostMeta,
  limit = 2,
  posts: BlogPostMeta[] = getAllBlogPosts(),
): BlogPostMeta[] {
  const candidates = posts.filter((p) => !p.draft && p.slug !== current.slug)

  if (current.related && current.related.length > 0) {
    // Dedupe slugs first (Set preserves insertion order) so a repeated slug in
    // frontmatter cannot render the same post twice.
    return [...new Set(current.related)]
      .map((slug) => candidates.find((p) => p.slug === slug))
      .filter((p): p is BlogPostMeta => Boolean(p))
      .slice(0, limit)
  }

  const tags = new Set(current.tags ?? [])
  if (tags.size === 0) return []

  return candidates
    .map((post) => ({
      post,
      shared: (post.tags ?? []).filter((tag) => tags.has(tag)).length,
    }))
    .filter((entry) => entry.shared > 0)
    .sort(
      (a, b) =>
        b.shared - a.shared ||
        (b.post.date || '').localeCompare(a.post.date || ''),
    )
    .slice(0, limit)
    .map((entry) => entry.post)
}

export function getBlogPostBySlug(slug: string): BlogPostMeta | undefined {
  return readPost(slug)
}
