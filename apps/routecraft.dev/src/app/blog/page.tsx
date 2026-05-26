import type { Metadata } from 'next'

import { BlogCard } from '@/components/BlogCard'
import { FeaturedBlogCard } from '@/components/FeaturedBlogCard'
import { getAllBlogPosts, getFeaturedPost } from '@/lib/blog'

export const metadata: Metadata = {
  title: 'Blog',
  description:
    'Patterns, tutorials, and field notes from building TypeScript automations and MCP servers with Routecraft.',
  openGraph: {
    title: 'Routecraft Blog',
    description:
      'Patterns, tutorials, and field notes from building TypeScript automations and MCP servers with Routecraft.',
    type: 'website',
  },
}

export default function BlogIndexPage() {
  const posts = getAllBlogPosts()
  const featured = getFeaturedPost(posts)
  const rest = posts.filter((post) => post.slug !== featured?.slug)

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-3xl text-center">
        <p className="font-display text-sm font-medium text-sky-500">
          The Routecraft Blog
        </p>
        <h1 className="mt-3 font-display text-4xl font-medium tracking-tight text-gray-900 sm:text-5xl dark:text-white">
          Patterns, tutorials, and field notes
        </h1>
        <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
          Deep dives on building TypeScript automations, exposing them as MCP
          tools for AI agents, and the architectural decisions behind
          Routecraft.
        </p>
      </section>

      {posts.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {featured && (
            <section className="mt-16">
              <SectionHeading
                eyebrow="Featured"
                title="What we're highlighting"
              />
              <div className="mt-6">
                <FeaturedBlogCard post={featured} />
              </div>
            </section>
          )}

          {rest.length > 0 && (
            <section className="mt-20">
              <SectionHeading
                eyebrow="Latest"
                title="Recent posts"
                description="Fresh writing on Routecraft, MCP, and authentication."
              />
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

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description?: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-display text-xs font-medium text-sky-500">
        {eyebrow}
      </p>
      <h2 className="font-display text-2xl font-medium tracking-tight text-gray-900 dark:text-white">
        {title}
      </h2>
      {description && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {description}
        </p>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="mt-16 rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-12 text-center dark:border-gray-700 dark:bg-gray-900">
      <h2 className="font-display text-xl font-medium text-gray-900 dark:text-white">
        No posts yet
      </h2>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        Check back soon. The first post is on its way.
      </p>
    </div>
  )
}

function SubscribeCallout() {
  return (
    <section className="mt-24 overflow-hidden rounded-3xl border border-gray-200 bg-linear-to-br from-sky-50 via-white to-white p-8 sm:p-12 dark:border-gray-800 dark:from-sky-950/40 dark:via-gray-900 dark:to-gray-900">
      <div className="grid grid-cols-1 items-center gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          <h2 className="font-display text-2xl font-medium tracking-tight text-gray-900 dark:text-white">
            Build something with Routecraft
          </h2>
          <p className="mt-3 text-base text-gray-600 dark:text-gray-400">
            Routecraft is a code-first automation framework for TypeScript.
            Write capabilities, expose them as MCP tools, and let agents do real
            work, on your terms.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
          <a
            href="/docs/introduction"
            className="inline-flex items-center justify-center rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-500"
          >
            Read the docs
          </a>
          <a
            href="https://github.com/routecraftjs/routecraft"
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-900 transition hover:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:hover:border-gray-600"
          >
            Star on GitHub
          </a>
        </div>
      </div>
    </section>
  )
}
