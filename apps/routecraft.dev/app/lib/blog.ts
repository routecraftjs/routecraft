import {
  type BlogPostMeta,
  filterPublished,
  lastModifiedDate,
  parseBlogPost,
  sortByDateDescending,
} from '@/lib/blog-post'
import { formatBlogDate } from '@/lib/blog-date'

// Re-exported so existing importers of `@/lib/blog` keep working. The shapes
// and the parsing rules live in `@/lib/blog-post`, which the build scripts read
// too, because they cannot go through the bundler-resolved sources below.
export { formatBlogDate, lastModifiedDate }
export type { BlogPostMeta }

/**
 * Post sources, resolved by the bundler rather than from disk.
 *
 * The blog index and home page read posts and render in both the server and the
 * browser bundle, where a filesystem read is not available.
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
  return parseBlogPost(slug, md)
}

let cachedPosts: BlogPostMeta[] | null = null

export function getAllBlogPosts(): BlogPostMeta[] {
  // Content is frozen in a production build and this is called repeatedly by
  // the blog index, the home page and the per-post metadata. In dev the cache
  // is skipped so edits to a post hot-reload.
  if (cachedPosts && import.meta.env.PROD) return cachedPosts
  const posts: BlogPostMeta[] = []
  for (const slug of BY_SLUG.keys()) {
    const post = readPost(slug)
    if (post) posts.push(post)
  }
  cachedPosts = sortByDateDescending(posts)
  return cachedPosts
}

/** See {@link filterPublished}. */
export function getPublishedPosts(
  posts: BlogPostMeta[] = getAllBlogPosts(),
): BlogPostMeta[] {
  return filterPublished(posts)
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

  // Any declared list wins, including an empty one: `related: []` is how a post
  // says it wants no suggestions, not a request for tag-based ones.
  if (current.related) {
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
