import Link from 'next/link'
import clsx from 'clsx'

import type { BlogPostMeta } from '@/lib/blog'
import { BlogMeta } from '@/components/BlogMeta'

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
        'group relative flex flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white transition hover:border-sky-300 hover:shadow-md dark:border-gray-800 dark:bg-gray-900 dark:hover:border-sky-500/40',
        className,
      )}
    >
      <Link
        href={post.href}
        className="flex h-full flex-col focus:outline-none"
      >
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-linear-to-br from-sky-100 via-gray-100 to-gray-200 dark:from-sky-950 dark:via-gray-900 dark:to-gray-950">
          {post.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={post.image}
              alt={post.imageAlt ?? ''}
              className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
            />
          ) : (
            <BlogCardPlaceholder title={post.title} />
          )}
          {post.draft && (
            <span className="absolute top-3 left-3 rounded-full bg-amber-500/90 px-2 py-0.5 text-xs font-medium text-white shadow-sm">
              Draft
            </span>
          )}
        </div>
        <div className="flex flex-1 flex-col p-6">
          {post.tags && post.tags.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {post.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-300"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          <h3 className="font-display text-xl font-medium text-gray-900 group-hover:text-sky-600 dark:text-white dark:group-hover:text-sky-300">
            {post.title}
          </h3>
          {post.description && (
            <p className="mt-2 line-clamp-3 text-sm text-gray-600 dark:text-gray-400">
              {post.description}
            </p>
          )}
          <div className="mt-auto pt-4">
            <BlogMeta
              date={post.date}
              readingTime={post.readingTime}
              className="text-xs"
            />
          </div>
        </div>
      </Link>
    </article>
  )
}

function BlogCardPlaceholder({ title }: { title: string }) {
  const initial = title.charAt(0).toUpperCase()
  return (
    <div className="flex h-full w-full items-center justify-center">
      <span className="font-display text-6xl font-light text-sky-400/60 dark:text-sky-300/40">
        {initial}
      </span>
    </div>
  )
}
