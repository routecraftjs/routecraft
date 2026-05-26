import Link from 'next/link'
import { type Node } from '@markdoc/markdoc'

import { Prose } from '@/components/Prose'
import { TableOfContents } from '@/components/TableOfContents'
import { BlogMeta } from '@/components/BlogMeta'
import { collectSections } from '@/lib/sections'
import { formatBlogDate } from '@/lib/blog'

interface BlogPostFrontmatter {
  title?: string
  description?: string
  date?: string
  author?: string
  authorRole?: string
  authorAvatar?: string
  tags?: string[]
  image?: string
  imageAlt?: string
  readingTime?: number
  draft?: boolean
}

export function BlogPostLayout({
  children,
  frontmatter,
  nodes,
}: {
  children: React.ReactNode
  frontmatter: BlogPostFrontmatter
  nodes: Array<Node>
}) {
  const tableOfContents = collectSections(nodes)
  const date = typeof frontmatter.date === 'string' ? frontmatter.date : ''

  return (
    <>
      <div className="max-w-3xl min-w-0 flex-auto px-4 py-12 lg:max-w-none lg:pr-0 lg:pl-8 xl:px-16">
        <article className="mx-auto max-w-3xl">
          <Link
            href="/blog"
            className="inline-flex items-center gap-1 text-sm font-medium text-sky-600 hover:text-sky-500 dark:text-sky-400"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path
                fillRule="evenodd"
                d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
                clipRule="evenodd"
              />
            </svg>
            All posts
          </Link>

          <header className="mt-6 space-y-5">
            {frontmatter.tags && frontmatter.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {frontmatter.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-300"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <h1 className="font-display text-4xl font-medium tracking-tight text-gray-900 lg:text-5xl dark:text-white">
              {frontmatter.title}
            </h1>
            {frontmatter.description && (
              <p className="text-lg text-gray-600 dark:text-gray-400">
                {frontmatter.description}
              </p>
            )}
            <BlogMeta
              date={date}
              readingTime={frontmatter.readingTime}
              author={frontmatter.author}
              authorRole={frontmatter.authorRole}
            />
            {frontmatter.draft && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                This post is a draft. Content may change before publication.
              </div>
            )}
          </header>

          {frontmatter.image && (
            <figure className="mt-10 overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={frontmatter.image}
                alt={frontmatter.imageAlt ?? ''}
                className="w-full"
              />
            </figure>
          )}

          <div className="mt-10">
            <Prose>{children}</Prose>
          </div>

          <footer className="mt-16 border-t border-gray-200 pt-8 dark:border-gray-800">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Have feedback on this post? Open an issue on{' '}
              <a
                href="https://github.com/routecraftjs/routecraft/issues"
                className="font-medium text-sky-600 hover:text-sky-500 dark:text-sky-400"
              >
                GitHub
              </a>
              .
            </p>
            <p className="mt-4">
              <Link
                href="/blog"
                className="inline-flex items-center gap-1 text-sm font-semibold text-sky-600 hover:text-sky-500 dark:text-sky-400"
              >
                Back to all posts
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-4 w-4"
                >
                  <path
                    fillRule="evenodd"
                    d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z"
                    clipRule="evenodd"
                  />
                </svg>
              </Link>
            </p>
          </footer>
        </article>
      </div>
      <TableOfContents tableOfContents={tableOfContents} />
    </>
  )
}

export type { BlogPostFrontmatter }
export { formatBlogDate }
