import Link from 'next/link'

import type { BlogPostMeta } from '@/lib/blog'
import { BlogMeta } from '@/components/BlogMeta'

export function FeaturedBlogCard({ post }: { post: BlogPostMeta }) {
  return (
    <article className="group relative overflow-hidden rounded-3xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <Link
        href={post.href}
        className="grid grid-cols-1 focus:outline-none lg:grid-cols-2"
      >
        <div className="relative aspect-[16/10] w-full overflow-hidden bg-linear-to-br from-sky-200 via-sky-100 to-gray-100 lg:aspect-auto lg:h-full dark:from-sky-900 dark:via-sky-950 dark:to-gray-900">
          {post.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={post.image}
              alt={post.imageAlt ?? ''}
              className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
            />
          ) : (
            <FeaturedPlaceholder title={post.title} />
          )}
          <span className="absolute top-4 left-4 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1 text-xs font-semibold text-sky-700 shadow-sm dark:bg-gray-950/80 dark:text-sky-300">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
            Featured
          </span>
          {post.draft && (
            <span className="absolute top-4 right-4 rounded-full bg-amber-500/90 px-2.5 py-1 text-xs font-medium text-white shadow-sm">
              Draft
            </span>
          )}
        </div>
        <div className="flex flex-col justify-center p-8 lg:p-12">
          {post.tags && post.tags.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {post.tags.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-300"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          <h2 className="font-display text-3xl font-medium tracking-tight text-gray-900 group-hover:text-sky-600 lg:text-4xl dark:text-white dark:group-hover:text-sky-300">
            {post.title}
          </h2>
          {post.description && (
            <p className="mt-4 text-base text-gray-600 dark:text-gray-400">
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
          <div className="mt-6">
            <span className="inline-flex items-center gap-1 text-sm font-semibold text-sky-600 group-hover:text-sky-500 dark:text-sky-400">
              Read post
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-4 w-4 transition group-hover:translate-x-0.5"
              >
                <path
                  fillRule="evenodd"
                  d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z"
                  clipRule="evenodd"
                />
              </svg>
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
    <div className="flex h-full w-full items-center justify-center">
      <span className="font-display text-9xl font-light text-sky-400/60 dark:text-sky-300/30">
        {initial}
      </span>
    </div>
  )
}
