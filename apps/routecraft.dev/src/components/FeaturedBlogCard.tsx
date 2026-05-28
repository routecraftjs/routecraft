import Link from 'next/link'

import type { BlogPostMeta } from '@/lib/blog'
import { BlogMeta } from '@/components/BlogMeta'

// Text-only featured card. The generated cover is reserved for the social card
// (page metadata) and the grid below, so the featured slot leads with the words.
export function FeaturedBlogCard({ post }: { post: BlogPostMeta }) {
  return (
    <article className="group relative flex flex-col border border-ink/15 transition hover:border-cobalt-500/50 dark:border-paper/15 dark:hover:border-cobalt-400/50">
      <Link
        href={post.href}
        className="flex h-full flex-col p-8 focus:outline-none lg:p-10"
      >
        <div className="flex items-center gap-3 font-mono text-[0.65rem] tracking-[0.22em] uppercase">
          <span className="flex items-center gap-2 text-cobalt-500">
            <span aria-hidden="true" className="h-1.5 w-1.5 bg-cobalt-500" />
            Featured
          </span>
          {post.draft && (
            <span className="border border-amber-500/40 px-2 py-0.5 text-amber-700 dark:text-amber-400">
              Draft
            </span>
          )}
        </div>

        {post.tags && post.tags.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center gap-2 font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase dark:text-paper/55">
            {post.tags.slice(0, 4).map((tag, i) => (
              <span key={tag} className="inline-flex items-center gap-2">
                {i > 0 && (
                  <span
                    aria-hidden="true"
                    className="text-ink/25 dark:text-paper/25"
                  >
                    ·
                  </span>
                )}
                {tag}
              </span>
            ))}
          </div>
        )}

        <h2 className="mt-5 font-editorial text-[1.9rem] leading-[1.1] tracking-[-0.02em] text-ink transition group-hover:text-cobalt-500 lg:text-[2.25rem] dark:text-paper dark:group-hover:text-cobalt-300">
          {post.title}
        </h2>

        {post.description && (
          <p className="mt-5 text-[1rem] leading-[1.65] text-ink/70 dark:text-paper/70">
            {post.description}
          </p>
        )}

        <div className="mt-auto pt-8">
          <BlogMeta
            date={post.date}
            readingTime={post.readingTime}
            author={post.author}
            authorRole={post.authorRole}
          />
          <span className="mt-6 inline-flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase">
            Read the post
            <span
              aria-hidden="true"
              className="transition group-hover:translate-x-1"
            >
              →
            </span>
          </span>
        </div>
      </Link>
    </article>
  )
}
