import Link from 'next/link'

import type { BlogPostMeta } from '@/lib/blog'
import { BlogMeta } from '@/components/BlogMeta'

export function FeaturedBlogCard({ post }: { post: BlogPostMeta }) {
  return (
    <article className="group relative border border-ink/15 transition hover:border-cobalt-500/50 dark:border-paper/15 dark:hover:border-cobalt-400/50">
      <Link
        href={post.href}
        className="grid grid-cols-1 focus:outline-none lg:grid-cols-2"
      >
        <div className="relative aspect-[16/10] w-full overflow-hidden border-b border-ink/15 lg:aspect-auto lg:h-full lg:border-r lg:border-b-0 dark:border-paper/15">
          {post.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={post.image}
              alt={post.imageAlt ?? ''}
              className="h-full w-full object-cover grayscale transition duration-500 group-hover:scale-105 group-hover:grayscale-0"
            />
          ) : (
            <FeaturedPlaceholder title={post.title} />
          )}
          <span className="absolute top-4 left-4 inline-flex items-center gap-2 border border-cobalt-500/50 bg-paper/90 px-3 py-1 font-mono text-[0.65rem] tracking-[0.22em] text-cobalt-500 uppercase dark:bg-ink/90">
            <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
            Featured
          </span>
          {post.draft && (
            <span className="absolute top-4 right-4 border border-amber-500/40 bg-paper/90 px-2.5 py-1 font-mono text-[0.65rem] tracking-[0.18em] text-amber-700 uppercase dark:bg-ink/90 dark:text-amber-400">
              Draft
            </span>
          )}
        </div>
        <div className="flex flex-col justify-center p-8 lg:p-12">
          {post.tags && post.tags.length > 0 && (
            <div className="mb-5 flex flex-wrap items-center gap-2 font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase dark:text-paper/55">
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
          <h2 className="font-editorial text-[2rem] leading-[1.1] tracking-[-0.02em] text-ink transition group-hover:text-cobalt-500 lg:text-[2.5rem] dark:text-paper dark:group-hover:text-cobalt-300">
            {post.title}
          </h2>
          {post.description && (
            <p className="mt-5 text-[1rem] leading-[1.65] text-ink/70 dark:text-paper/70">
              {post.description}
            </p>
          )}
          <div className="mt-6">
            <BlogMeta
              date={post.date}
              readingTime={post.readingTime}
              author={post.author}
              authorRole={post.authorRole}
            />
          </div>
          <div className="mt-8">
            <span className="inline-flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase">
              Read the post
              <span
                aria-hidden="true"
                className="transition group-hover:translate-x-1"
              >
                →
              </span>
            </span>
          </div>
        </div>
      </Link>
    </article>
  )
}

function FeaturedPlaceholder({ title }: { title: string }) {
  const initial = title.charAt(0).toUpperCase()
  return (
    <div className="flex h-full w-full items-center justify-center bg-paper-deep/30 dark:bg-ink-soft/30">
      <span
        aria-hidden="true"
        className="font-editorial text-[10rem] leading-none text-cobalt-500/20"
        style={{ fontVariationSettings: '"opsz" 144, "SOFT" 100' }}
      >
        {initial}
      </span>
    </div>
  )
}
