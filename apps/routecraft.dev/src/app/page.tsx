import Link from 'next/link'
import type { Metadata } from 'next'

import { DataFlowAnimation } from '@/components/DataFlowAnimation'
import { BlogMeta } from '@/components/BlogMeta'
import { type BlogPostMeta, getAllBlogPosts, getFeaturedPost } from '@/lib/blog'

export const metadata: Metadata = {
  title: 'Routecraft - AI automation as code',
  description:
    'Type-safe TypeScript framework for connecting AI agents to your real systems. Write capabilities once, expose them over MCP, cron, or webhook.',
}

const resourceCards = [
  {
    title: 'Documentation',
    description: 'Concepts, adapters, operations, and the full API reference.',
    href: '/docs/introduction',
  },
  {
    title: 'Cheat sheet',
    description: 'The whole DSL on one printable page.',
    href: '/cheat-sheet',
  },
  {
    title: 'Blog',
    description: 'Patterns, tutorials, and field notes.',
    href: '/blog',
  },
  {
    title: 'Examples',
    description: 'Working capabilities you can fork and extend.',
    href: '/docs/examples',
  },
  {
    title: 'Adapters',
    description: 'Every source, destination, and transformer in one list.',
    href: '/docs/reference/adapters',
  },
  {
    title: 'Changelog',
    description: 'What landed in each release and what is coming next.',
    href: '/docs/changelog',
  },
]

const features = [
  {
    title: 'Type-safe end to end',
    description:
      'Types flow through every operation. The body shape at .to() is inferred from the body shape at .from() and every transform in between.',
  },
  {
    title: 'One DSL, every trigger',
    description:
      'Cron, webhook, MCP, IMAP, channel, file. Swap one line to change how a capability is invoked. The business logic is unchanged.',
  },
  {
    title: 'Native MCP integration',
    description:
      'Set the source to mcp() and the capability becomes an MCP tool that Claude Desktop, Cursor, and any MCP client can call.',
  },
  {
    title: 'Standard Schema validation',
    description:
      'Bring Zod, Valibot, ArkType, or anything that speaks Standard Schema. Inputs validate before your code runs.',
  },
  {
    title: 'Auth as a primitive',
    description:
      'jwks() verifies bearer tokens. .authorize({ roles }) gates capabilities. userinfo hydrates the principal from your IdP.',
  },
  {
    title: 'Compose capabilities',
    description:
      'direct() lets one capability call another with full type safety. Build a graph, test each node in isolation.',
  },
  {
    title: 'Structured logging out of the box',
    description:
      'Every step emits structured events. Pipe them to your log aggregator, or watch them live in the built-in TUI.',
  },
  {
    title: 'Plugin system',
    description:
      'Telemetry, AI, mail, custom adapters. Plugins extend the runtime without forking it.',
  },
  {
    title: 'Runs on Bun or Node',
    description:
      'The CLI runs TypeScript directly on Bun. Embed in any Node 22+ app via ContextBuilder.',
  },
]

const trustedLogos = [
  'Acme Corp',
  'Globex',
  'Initech',
  'Umbrella',
  'Stark Industries',
  'Wayne Enterprises',
]

export default function LandingPage() {
  const featuredPost = getFeaturedPost(getAllBlogPosts())

  return (
    <div className="w-full">
      <LandingHero />
      <ResourceGrid />
      <Features />
      {featuredPost && <FeaturedBlogTeaser post={featuredPost} />}
      <TrustedBy logos={trustedLogos} />
      <FinalCTA />
    </div>
  )
}

function LandingHero() {
  return (
    <section className="relative overflow-hidden border-b border-gray-200 dark:border-gray-800">
      <div className="absolute inset-0 bg-linear-to-br from-sky-50 via-white to-white dark:from-sky-950/30 dark:via-gray-950 dark:to-gray-950" />
      <div className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-sky-300/40 to-transparent dark:via-sky-500/30" />

      <div className="relative mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:gap-8 lg:px-8 lg:py-24">
        <div>
          <p className="font-display text-sm font-medium text-sky-500">
            AI automation as code
          </p>
          <h1 className="mt-3 font-display text-4xl font-medium tracking-tight text-gray-900 sm:text-5xl lg:text-6xl dark:text-white">
            Connect AI agents to{' '}
            <span className="bg-linear-to-r from-sky-500 via-indigo-500 to-sky-500 bg-clip-text text-transparent">
              your real systems
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-gray-600 dark:text-gray-400">
            Routecraft is a type-safe TypeScript framework for the boring,
            high-stakes plumbing between AI agents and the rest of your stack.
            Write capabilities once. Expose them over MCP, schedule them, or
            wire them to webhooks. Same code, every shape.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/docs/introduction/installation"
              className="inline-flex items-center justify-center rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-500"
            >
              Get started
            </Link>
            <Link
              href="/cheat-sheet"
              className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-900 transition hover:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:hover:border-gray-600"
            >
              Cheat sheet
            </Link>
            <a
              href="https://github.com/routecraftjs/routecraft"
              className="inline-flex items-center justify-center rounded-lg border border-transparent px-5 py-2.5 text-sm font-semibold text-gray-700 transition hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
            >
              View on GitHub
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="ml-1 h-4 w-4"
              >
                <path
                  fillRule="evenodd"
                  d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z"
                  clipRule="evenodd"
                />
              </svg>
            </a>
          </div>

          <div className="mt-8 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <kbd className="rounded border border-gray-300 bg-gray-100 px-2 py-1 font-mono text-xs dark:border-gray-700 dark:bg-gray-800">
              bunx create-routecraft my-app
            </kbd>
            <span>or scaffold in one line.</span>
          </div>
        </div>

        <div className="relative">
          <DataFlowAnimation />
        </div>
      </div>
    </section>
  )
}

function ResourceGrid() {
  return (
    <section className="border-b border-gray-200 dark:border-gray-800">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-2">
          <p className="font-display text-sm font-medium text-sky-500">
            Get into it
          </p>
          <h2 className="font-display text-3xl font-medium tracking-tight text-gray-900 dark:text-white">
            Everything you need, one click away
          </h2>
        </div>
        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {resourceCards.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className="group relative flex flex-col gap-2 rounded-2xl border border-gray-200 bg-white p-6 transition hover:border-sky-300 hover:shadow-md dark:border-gray-800 dark:bg-gray-900/40 dark:hover:border-sky-500/40"
            >
              <h3 className="font-display text-lg font-medium text-gray-900 group-hover:text-sky-600 dark:text-white dark:group-hover:text-sky-300">
                {card.title}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {card.description}
              </p>
              <span className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-sky-600 group-hover:text-sky-500 dark:text-sky-400">
                Open
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
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}

function Features() {
  return (
    <section className="border-b border-gray-200 bg-gray-50/60 dark:border-gray-800 dark:bg-gray-900/30">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-2">
          <p className="font-display text-sm font-medium text-sky-500">
            Why Routecraft
          </p>
          <h2 className="font-display text-3xl font-medium tracking-tight text-gray-900 dark:text-white">
            One framework for cron, webhooks, MCP, and everything between
          </h2>
          <p className="mt-2 max-w-2xl text-base text-gray-600 dark:text-gray-400">
            The shape of a Routecraft capability does not change when you
            change how it is triggered. That is the entire pitch.
          </p>
        </div>
        <div className="mt-12 grid grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div key={feature.title} className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 font-display text-base font-medium text-gray-900 dark:text-white">
                <span
                  aria-hidden="true"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-sky-100 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400"
                >
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="h-3.5 w-3.5"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.704 5.296a1 1 0 010 1.414l-7.5 7.5a1 1 0 01-1.414 0l-3.5-3.5a1 1 0 011.414-1.414L8.5 12.086l6.79-6.79a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
                {feature.title}
              </h3>
              <p className="pl-8 text-sm text-gray-600 dark:text-gray-400">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function FeaturedBlogTeaser({ post }: { post: BlogPostMeta }) {
  return (
    <section className="border-b border-gray-200 dark:border-gray-800">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-2">
          <p className="font-display text-sm font-medium text-sky-500">
            From the blog
          </p>
          <h2 className="font-display text-3xl font-medium tracking-tight text-gray-900 dark:text-white">
            Reading time
          </h2>
        </div>
        <Link
          href={post.href}
          className="group mt-8 grid grid-cols-1 overflow-hidden rounded-3xl border border-gray-200 bg-white transition hover:border-sky-300 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-sky-500/40 lg:grid-cols-[3fr_2fr]"
        >
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
            <h3 className="font-display text-2xl font-medium tracking-tight text-gray-900 group-hover:text-sky-600 lg:text-3xl dark:text-white dark:group-hover:text-sky-300">
              {post.title}
            </h3>
            {post.description && (
              <p className="mt-3 text-base text-gray-600 dark:text-gray-400">
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
            <span className="mt-6 inline-flex items-center gap-1 text-sm font-semibold text-sky-600 group-hover:text-sky-500 dark:text-sky-400">
              Read the post
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
          <div className="relative aspect-[4/3] w-full overflow-hidden bg-linear-to-br from-sky-200 via-sky-100 to-gray-100 lg:aspect-auto dark:from-sky-900 dark:via-sky-950 dark:to-gray-900">
            {post.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={post.image}
                alt={post.imageAlt ?? ''}
                className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <span className="font-display text-8xl font-light text-sky-400/50 dark:text-sky-300/30">
                  {post.title.charAt(0)}
                </span>
              </div>
            )}
          </div>
        </Link>
        <div className="mt-6">
          <Link
            href="/blog"
            className="inline-flex items-center gap-1 text-sm font-medium text-sky-600 hover:text-sky-500 dark:text-sky-400"
          >
            See all posts
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
        </div>
      </div>
    </section>
  )
}

function TrustedBy({ logos }: { logos: string[] }) {
  return (
    <section
      className="hidden border-b border-gray-200 dark:border-gray-800"
      aria-label="Trusted by"
      data-trusted-by="placeholder"
    >
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <p className="text-center font-display text-sm font-medium text-gray-500 dark:text-gray-400">
          Trusted by teams building with AI
        </p>
        <div className="mt-8 grid grid-cols-2 items-center gap-x-8 gap-y-6 sm:grid-cols-3 lg:grid-cols-6">
          {logos.map((name) => (
            <div
              key={name}
              className="flex h-12 items-center justify-center text-base font-semibold tracking-tight text-gray-400 dark:text-gray-500"
            >
              {name}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function FinalCTA() {
  return (
    <section className="bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="overflow-hidden rounded-3xl border border-gray-200 bg-linear-to-br from-sky-50 via-white to-white p-8 sm:p-12 dark:border-gray-800 dark:from-sky-950/40 dark:via-gray-900 dark:to-gray-900">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-3xl font-medium tracking-tight text-gray-900 sm:text-4xl dark:text-white">
              Try it without leaving your browser
            </h2>
            <p className="mt-4 text-base text-gray-600 dark:text-gray-400">
              Open the playground in GitHub Codespaces and have a working MCP
              server in about thirty seconds. Or scaffold locally.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <a
                href="https://codespaces.new/routecraftjs/craft-playground"
                className="inline-flex items-center justify-center rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-500"
              >
                Open the playground
              </a>
              <Link
                href="/docs/introduction/installation"
                className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-900 transition hover:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:hover:border-gray-600"
              >
                Install locally
              </Link>
            </div>
            <p className="mt-6 text-xs text-gray-500 dark:text-gray-400">
              <kbd className="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 font-mono text-[0.7rem] dark:border-gray-700 dark:bg-gray-800">
                bunx create-routecraft my-app
              </kbd>
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
