import Link from 'next/link'
import type { Metadata } from 'next'

import { BlogCard } from '@/components/BlogCard'
import { FeaturedBlogCard } from '@/components/FeaturedBlogCard'
import { getAllBlogPosts } from '@/lib/blog'

export const metadata: Metadata = {
  title: 'Blog',
  description:
    'Patterns, tutorials, and field notes from building TypeScript automations and MCP servers with Routecraft.',
  alternates: { canonical: '/blog' },
  openGraph: {
    title: 'Routecraft Blog',
    description:
      'Patterns, tutorials, and field notes from building TypeScript automations and MCP servers with Routecraft.',
    url: '/blog',
    type: 'website',
  },
}

export default function BlogIndexPage() {
  const posts = getAllBlogPosts()
  // Lead with up to two posts (featured non-drafts first, then most recent),
  // then show the remaining posts in the grid below.
  const featured = [
    ...posts.filter((p) => p.featured && !p.draft),
    ...posts.filter((p) => !p.featured && !p.draft),
    ...posts.filter((p) => p.draft),
  ]
    .slice(0, 2)
    .reverse()
  const featuredSlugs = new Set(featured.map((p) => p.slug))
  const rest = posts.filter((post) => !featuredSlugs.has(post.slug))

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
      <section className="max-w-3xl">
        <p className="flex items-center gap-3 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase">
          <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
          <span>The Routecraft Blog</span>
        </p>
        <h1 className="mt-8 font-editorial text-[clamp(2.5rem,5vw,4rem)] leading-[1.05] font-medium tracking-[-0.025em] text-ink">
          From the <span className="text-cobalt-500 italic">field.</span>
        </h1>
        <p className="mt-6 max-w-2xl font-editorial text-[1.15rem] leading-[1.55] text-ink/70 italic">
          Tutorials, postmortems, and small notes from building Routecraft in
          production.
        </p>
      </section>

      {posts.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {featured.length > 0 && (
            <section className="mt-20">
              <SectionLabel label="Featured" />
              <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
                {featured.map((post) => (
                  <FeaturedBlogCard key={post.slug} post={post} />
                ))}
              </div>
            </section>
          )}

          {rest.length > 0 && (
            <section className="mt-24">
              <SectionLabel label="Recent posts" />
              <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {rest.map((post) => (
                  <BlogCard key={post.slug} post={post} />
                ))}
              </div>
            </section>
          )}

          <SubscribeCallout />
        </>
      )}
    </main>
  )
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-4">
      <span aria-hidden="true" className="h-1.5 w-1.5 bg-cobalt-500" />
      <span className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase">
        {label}
      </span>
      <span className="h-px flex-1 bg-ink/15" />
    </div>
  )
}

function EmptyState() {
  return (
    <div className="mt-16 border border-dashed border-ink/30 p-12 text-center">
      <h2 className="font-editorial text-[1.5rem] tracking-[-0.01em] text-ink">
        No posts yet.
      </h2>
      <p className="mt-3 font-editorial text-[1rem] text-ink/65 italic">
        Check back soon. The first post is on its way.
      </p>
    </div>
  )
}

function SubscribeCallout() {
  return (
    <section className="mt-24 border border-ink/15 bg-paper-deep/30 p-8 sm:p-12">
      <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-[2fr_1fr]">
        <div>
          <p className="flex items-center gap-3 font-mono text-[0.65rem] tracking-[0.22em] text-cobalt-500 uppercase">
            <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
            <span>Build with Routecraft</span>
          </p>
          <h2 className="mt-4 font-editorial text-[clamp(1.75rem,3vw,2.25rem)] leading-[1.1] tracking-[-0.015em] text-ink">
            A code-first automation framework{' '}
            <span className="text-cobalt-500 italic">for TypeScript.</span>
          </h2>
          <p className="mt-4 max-w-xl text-[1rem] leading-[1.65] text-ink/70">
            Write capabilities, expose them as MCP tools, and let agents do real
            work on your terms.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
          <Link
            href="/docs/introduction"
            className="group inline-flex items-center justify-center gap-2 bg-cobalt-500 px-5 py-3 font-mono text-[0.7rem] tracking-[0.22em] text-paper uppercase transition hover:bg-cobalt-600"
          >
            <span>Read the docs</span>
            <span
              aria-hidden="true"
              className="transition group-hover:translate-x-1"
            >
              →
            </span>
          </Link>
          <a
            href="https://github.com/routecraftjs/routecraft"
            className="inline-flex items-center justify-center gap-2 border border-ink/30 px-5 py-3 font-mono text-[0.7rem] tracking-[0.22em] text-ink uppercase transition hover:border-cobalt-500 hover:text-cobalt-500"
          >
            <span>Star on GitHub</span>
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </section>
  )
}
