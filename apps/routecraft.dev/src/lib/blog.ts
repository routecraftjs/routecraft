import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

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
  readingTime: number
  href: string
}

const WORDS_PER_MINUTE = 220

function parseFrontmatter(md: string): {
  data: Record<string, unknown>
  body: string
} {
  const match = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { data: {}, body: md }
  const data = (yaml.load(match[1]) as Record<string, unknown>) ?? {}
  return { data, body: match[2] ?? '' }
}

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
    readingTime:
      typeof data.readingTime === 'number'
        ? data.readingTime
        : estimateReadingTime(body),
    href: `/blog/${slug}`,
  }
}

export function getAllBlogPosts(): BlogPostMeta[] {
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
