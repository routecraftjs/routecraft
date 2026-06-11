import fs from 'fs'
import path from 'path'

import { parseFrontmatter } from '@/lib/frontmatter'

export interface BlogPostMeta {
  slug: string
  title: string
  description?: string
  date: string
  author?: string
  authorRole?: string
  authorAvatar?: string
  tags?: string[]
  /** Routecraft version the post was written for / verified against. */
  version?: string
  featured?: boolean
  draft?: boolean
  image?: string
  imageAlt?: string
  /** Override the auto-picked cover glyph. First character only. */
  coverGlyph?: string
  /**
   * Slugs of related posts, declared in frontmatter. Rendering is
   * bidirectional: a post appears in another post's related list when
   * either side declares the relationship. Draft posts never render,
   * so relationships can be declared ahead of publication and appear
   * automatically once the related post goes live.
   */
  related?: string[]
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

function readPost(blogDir: string, slug: string): BlogPostMeta | undefined {
  const file = path.join(blogDir, slug, 'page.md')
  if (!fs.existsSync(file)) return undefined
  const md = fs.readFileSync(file, 'utf8')
  const { data, body } = parseFrontmatter(md)
  if (data.published === false) return undefined

  const rawDate = data.date
  const date =
    rawDate instanceof Date
      ? rawDate.toISOString().slice(0, 10)
      : typeof rawDate === 'string'
        ? rawDate
        : ''

  return {
    slug,
    title: typeof data.title === 'string' ? data.title : slug,
    description:
      typeof data.description === 'string' ? data.description : undefined,
    date,
    author: typeof data.author === 'string' ? data.author : undefined,
    authorRole:
      typeof data.authorRole === 'string' ? data.authorRole : undefined,
    authorAvatar:
      typeof data.authorAvatar === 'string' ? data.authorAvatar : undefined,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : undefined,
    version: typeof data.version === 'string' ? data.version : undefined,
    featured: Boolean(data.featured),
    draft: Boolean(data.draft),
    image: typeof data.image === 'string' ? data.image : undefined,
    imageAlt: typeof data.imageAlt === 'string' ? data.imageAlt : undefined,
    coverGlyph:
      typeof data.coverGlyph === 'string' ? data.coverGlyph : undefined,
    related: Array.isArray(data.related) ? data.related.map(String) : undefined,
    readingTime:
      typeof data.readingTime === 'number'
        ? data.readingTime
        : estimateReadingTime(body),
    href: `/blog/${slug}/`,
  }
}

let cachedPosts: BlogPostMeta[] | null = null

export function getAllBlogPosts(): BlogPostMeta[] {
  // Cache the build-time filesystem scan in production (static export), where
  // content is frozen and this is called repeatedly: sitemap, RSS feed, the
  // blog index, and once per OG image. In dev we skip the cache so edits to a
  // post hot-reload without a server restart.
  if (cachedPosts && process.env.NODE_ENV === 'production') return cachedPosts
  const blogDir = path.join(process.cwd(), 'src', 'app', 'blog')
  if (!fs.existsSync(blogDir)) return []
  const entries = fs.readdirSync(blogDir, { withFileTypes: true })
  const posts: BlogPostMeta[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const post = readPost(blogDir, entry.name)
    if (post) posts.push(post)
  }
  posts.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  cachedPosts = posts
  return posts
}

export function getFeaturedPost(
  posts: BlogPostMeta[] = getAllBlogPosts(),
): BlogPostMeta | undefined {
  return (
    posts.find((p) => p.featured && !p.draft) ??
    posts.find((p) => !p.draft) ??
    posts[0]
  )
}

export function getBlogPostBySlug(slug: string): BlogPostMeta | undefined {
  const blogDir = path.join(process.cwd(), 'src', 'app', 'blog')
  return readPost(blogDir, slug)
}

/**
 * Published posts related to the given one, newest first, capped at four.
 * A relationship counts when either side declares the other's slug in its
 * `related` frontmatter; drafts are excluded from the result but may still
 * declare relationships, which start rendering when they publish.
 */
export function getRelatedPosts(current: {
  slug?: string
  title?: string
}): BlogPostMeta[] {
  const posts = getAllBlogPosts()
  const me =
    posts.find((p) => p.slug === current.slug) ??
    posts.find((p) => p.title === current.title)
  if (!me) return []
  return posts
    .filter(
      (p) =>
        p.slug !== me.slug &&
        !p.draft &&
        ((me.related?.includes(p.slug) ?? false) ||
          (p.related?.includes(me.slug) ?? false)),
    )
    .slice(0, 4)
}

export function formatBlogDate(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
