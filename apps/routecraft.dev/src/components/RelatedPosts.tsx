import Link from 'next/link'

import { formatBlogDate, type BlogPostMeta } from '@/lib/blog'

export function RelatedPosts({ posts }: { posts: BlogPostMeta[] }) {
  if (posts.length === 0) return null

  return (
    <section className="mt-16 border-t border-ink/15 pt-8">
      <h2 className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase">
        Related posts
      </h2>
      <ul className="mt-6 space-y-6">
        {posts.map((post) => (
          <li key={post.slug}>
            <Link href={post.href} className="group block">
              <span className="font-editorial text-[1.1rem] leading-snug text-ink transition group-hover:text-cobalt-600">
                {post.title}
              </span>
              {post.description && (
                <span className="mt-1 block text-sm leading-relaxed text-ink/60">
                  {post.description}
                </span>
              )}
              <span className="mt-1 block font-mono text-[0.65rem] tracking-[0.22em] text-ink/45 uppercase">
                {formatBlogDate(post.date)}
                {post.readingTime ? ` · ${post.readingTime} min read` : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
