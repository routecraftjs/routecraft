import Link from 'next/link'

import type { BlogPostMeta } from '@/lib/blog'
import { BlogMeta } from '@/components/BlogMeta'
import { SectionLabel } from '@/components/SectionLabel'

// Text-forward "keep reading" cards shown at the foot of a post. Deliberately
// lighter than the index grid: no cover art, just the tags, title, and meta, so
// the suggestion reads as a quiet nudge rather than a second hero.
export function RelatedPosts({ posts }: { posts: BlogPostMeta[] }) {
  if (posts.length === 0) return null

  return (
    <section className="mt-20 border-t border-ink/15 pt-10">
      <SectionLabel label="Keep reading" />
      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
        {posts.map((post) => (
          <article
            key={post.slug}
            className="group relative flex flex-col border border-ink/15 bg-paper-deep/30 transition hover:border-cobalt-500/50"
          >
            <Link
              href={post.href}
              className="flex h-full flex-col p-6 focus:outline-none"
            >
              {post.tags && post.tags.length > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-2 font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase">
                  {post.tags.slice(0, 3).map((tag, i) => (
                    <span key={tag} className="inline-flex items-center gap-2">
                      {i > 0 && (
                        <span aria-hidden="true" className="text-ink/25">
                          ·
                        </span>
                      )}
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <h3 className="font-editorial text-[1.3rem] leading-[1.2] tracking-[-0.015em] text-ink transition group-hover:text-cobalt-500">
                {post.title}
              </h3>
              {post.description && (
                <p className="mt-3 line-clamp-2 text-sm leading-[1.6] text-ink/65">
                  {post.description}
                </p>
              )}
              <div className="mt-auto pt-5">
                <BlogMeta date={post.date} readingTime={post.readingTime} />
              </div>
            </Link>
          </article>
        ))}
      </div>
    </section>
  )
}
