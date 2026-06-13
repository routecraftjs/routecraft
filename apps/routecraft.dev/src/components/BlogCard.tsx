import Link from 'next/link'
import clsx from 'clsx'

import type { BlogPostMeta } from '@/lib/blog'
import { BlogMeta } from '@/components/BlogMeta'
import { BlogCoverInline } from '@/components/BlogCover'

export function BlogCard({
  post,
  className,
}: {
  post: BlogPostMeta
  className?: string
}) {
  return (
    <article
      className={clsx(
        'group relative flex flex-col border border-ink/15 bg-paper-deep/30 transition hover:border-cobalt-500/50',
        className,
      )}
    >
      <Link
        href={post.href}
        className="flex h-full flex-col focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt-500"
      >
        <div
          className="relative w-full overflow-hidden border-b border-ink/15"
          style={{ aspectRatio: '1200 / 630' }}
        >
          {post.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={post.image}
              alt={post.imageAlt ?? post.title}
              className="h-full w-full object-cover grayscale transition duration-500 group-hover:scale-105 group-hover:grayscale-0"
            />
          ) : (
            <BlogCoverInline
              title={post.title}
              slug={post.slug}
              tags={post.tags}
            />
          )}
          {post.draft && (
            <span className="absolute top-3 left-3 border border-amber-500/40 bg-paper/90 px-2 py-0.5 font-mono text-[0.65rem] tracking-[0.18em] text-amber-700 uppercase dark:text-amber-400">
              Draft
            </span>
          )}
        </div>
        <div className="flex flex-1 flex-col p-6">
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
          <h3 className="font-editorial text-[1.4rem] leading-[1.2] tracking-[-0.015em] text-ink transition group-hover:text-cobalt-500">
            {post.title}
          </h3>
          {post.description && (
            <p className="mt-3 line-clamp-3 text-sm leading-[1.6] text-ink/65">
              {post.description}
            </p>
          )}
          <div className="mt-auto pt-5">
            <BlogMeta date={post.date} readingTime={post.readingTime} />
          </div>
        </div>
      </Link>
    </article>
  )
}
