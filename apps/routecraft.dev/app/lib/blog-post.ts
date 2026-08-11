import { parseFrontmatter } from '@/lib/frontmatter'

/**
 * Frontmatter to post metadata, with no notion of where the source came from.
 *
 * The site reads posts through the bundler (`@/lib/blog`), while the sitemap,
 * feed and OG image scripts read the same files from disk under Bun. Both go
 * through this module so the two paths cannot drift on which posts count as
 * published or how a date is coerced.
 */
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
 * One post's metadata, or `undefined` when its frontmatter says
 * `published: false`. Unpublished is absence everywhere downstream, so it is
 * resolved here rather than left for each caller to remember.
 */
export function parseBlogPost(
  slug: string,
  source: string,
): BlogPostMeta | undefined {
  const { data, body } = parseFrontmatter(source)
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

/**
 * A post's effective last-modified date (`YYYY-MM-DD`): `updated` when the
 * author set it, otherwise the publish `date`. One definition of the freshness
 * policy so `dateModified`, `article:modified_time`, and the sitemap's `lastmod`
 * cannot disagree for the same post.
 */
export function lastModifiedDate(post: BlogPostMeta): string {
  return post.updated ?? post.date
}

/**
 * Posts safe to expose publicly (drafts excluded). The single definition of
 * "publicly visible" shared by the sitemap, RSS feed, blog index, and OG image
 * numbering, so those surfaces cannot drift on which posts are discoverable.
 */
export function filterPublished(posts: BlogPostMeta[]): BlogPostMeta[] {
  return posts.filter((p) => !p.draft)
}

/** Newest first, the order every post listing presents. */
export function sortByDateDescending(posts: BlogPostMeta[]): BlogPostMeta[] {
  return [...posts].sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}
