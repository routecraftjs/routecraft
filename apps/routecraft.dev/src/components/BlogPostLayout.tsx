import Link from 'next/link'
import { type Node } from '@markdoc/markdoc'

import { Prose } from '@/components/Prose'
import { TableOfContents } from '@/components/TableOfContents'
import { BlogMeta } from '@/components/BlogMeta'
import { BlogCoverInline } from '@/components/BlogCover'
import { collectSections } from '@/lib/sections'
import { formatBlogDate, getAllBlogPosts } from '@/lib/blog'

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
  coverGlyph?: string
  readingTime?: number
  draft?: boolean
  slug?: string
}

function resolveSlugAndFigure(frontmatter: BlogPostFrontmatter): {
  slug: string
  figureNumber: number
} {
  const all = getAllBlogPosts()
    .filter((post) => !post.draft)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  const explicit = frontmatter.slug
  const match = explicit
    ? all.find((post) => post.slug === explicit)
    : all.find((post) => post.title === frontmatter.title)
  const slug = match?.slug ?? frontmatter.title ?? 'post'
  const index = match ? all.indexOf(match) : -1
  const figureNumber = index >= 0 ? index + 1 : all.length + 1
  return { slug, figureNumber }
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
  const { slug, figureNumber } = resolveSlugAndFigure(frontmatter)

  return (
    <>
      <div className="max-w-3xl min-w-0 flex-auto px-4 py-16 lg:max-w-none lg:pr-0 lg:pl-8 xl:px-16">
        <article className="mx-auto max-w-3xl">
          <Link
            href="/blog"
            className="group inline-flex items-center gap-2 font-mono text-[0.65rem] tracking-[0.22em] text-cobalt-500 uppercase transition hover:text-cobalt-600 dark:hover:text-cobalt-300"
          >
            <span
              aria-hidden="true"
              className="transition group-hover:-translate-x-1"
            >
              ←
            </span>
            <span>All posts</span>
          </Link>

          <header className="mt-8 space-y-6">
            {frontmatter.tags && frontmatter.tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase dark:text-paper/55">
                {frontmatter.tags.map((tag, i) => (
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
            <h1 className="font-editorial text-[clamp(2.25rem,5vw,3.5rem)] leading-[1.05] font-medium tracking-[-0.02em] text-ink dark:text-paper">
              {frontmatter.title}
            </h1>
            {frontmatter.description && (
              <p className="font-editorial text-[1.2rem] leading-[1.5] text-ink/70 italic dark:text-paper/70">
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
              <div className="flex items-baseline gap-3 border border-l-4 border-amber-500/40 border-l-amber-500 p-4">
                <span className="font-mono text-[0.65rem] tracking-[0.22em] text-amber-600 uppercase dark:text-amber-400">
                  Draft
                </span>
                <span className="text-sm text-ink/75 dark:text-paper/75">
                  Content may change before publication.
                </span>
              </div>
            )}
          </header>

          {frontmatter.image ? (
            <figure className="mt-12 border border-ink/15 dark:border-paper/15">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={frontmatter.image}
                alt={frontmatter.imageAlt ?? ''}
                className="w-full"
              />
            </figure>
          ) : (
            <figure className="mt-12 border border-ink/15 dark:border-paper/15">
              <BlogCoverInline
                title={frontmatter.title ?? ''}
                slug={slug}
                tags={frontmatter.tags}
                subtitle={frontmatter.description}
                glyph={frontmatter.coverGlyph}
                figureNumber={figureNumber}
              />
            </figure>
          )}

          <div className="mt-12">
            <Prose>{children}</Prose>
          </div>

          <footer className="mt-20 border-t border-ink/15 pt-8 dark:border-paper/15">
            <p className="font-editorial text-[1rem] text-ink/70 italic dark:text-paper/70">
              Have feedback on this post? Open an issue on{' '}
              <a
                href="https://github.com/routecraftjs/routecraft/issues"
                className="text-cobalt-500 not-italic transition hover:text-cobalt-600 dark:hover:text-cobalt-300"
              >
                GitHub
              </a>
              .
            </p>
            <p className="mt-6">
              <Link
                href="/blog"
                className="group inline-flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase transition hover:text-cobalt-600 dark:hover:text-cobalt-300"
              >
                <span>Back to all posts</span>
                <span
                  aria-hidden="true"
                  className="transition group-hover:translate-x-1"
                >
                  →
                </span>
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
