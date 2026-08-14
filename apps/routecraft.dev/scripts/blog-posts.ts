/**
 * Blog post metadata read from disk, for the build-time generators.
 *
 * `@/lib/blog` resolves the same sources through `import.meta.glob`, which only
 * the bundler understands. The scripts run under plain Bun, so they read the
 * files themselves and hand them to the shared parser, which owns every rule
 * about what a post is.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  type BlogPostMeta,
  filterPublished,
  parseBlogPost,
  sortByDateDescending,
} from '../app/lib/blog-post'
import { CONTENT_DIR } from './paths'

export type { BlogPostMeta }
export { lastModifiedDate } from '../app/lib/blog-post'

const BLOG_DIR = path.join(CONTENT_DIR, 'blog')

/** Whether there is a blog content root at all (the sitemap gates on this). */
export function hasBlogContent(): boolean {
  return fs.existsSync(BLOG_DIR)
}

function readAllPosts(): BlogPostMeta[] {
  if (!hasBlogContent()) return []
  const posts: BlogPostMeta[] = []
  for (const entry of fs.readdirSync(BLOG_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const source = path.join(BLOG_DIR, entry.name, 'index.mdx')
    if (!fs.existsSync(source)) continue
    const post = parseBlogPost(entry.name, fs.readFileSync(source, 'utf8'))
    if (post) posts.push(post)
  }
  return sortByDateDescending(posts)
}

let cached: BlogPostMeta[] | null = null

/**
 * Every post with a route, newest first. Drafts are included: they are
 * reachable by direct link for preview, so they still need a social card and
 * per-post metadata. Only `published: false` removes a post entirely.
 */
export function getAllPosts(): BlogPostMeta[] {
  cached ??= readAllPosts()
  return cached
}

/** Published posts, newest first. Matches `getPublishedPosts()` on the site. */
export function getPublishedPosts(): BlogPostMeta[] {
  return filterPublished(getAllPosts())
}
