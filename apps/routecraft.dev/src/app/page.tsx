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

interface ResourceCard {
  title: string
  description: string
  href: string
  icon: React.ReactNode
}

const iconClass = 'h-5 w-5'

const resourceCards: ResourceCard[] = [
  {
    title: 'Documentation',
    description:
      'Concepts, adapters, operations, and the full API reference. The source of truth for everything Routecraft.',
    href: '/docs/introduction',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={iconClass}
        aria-hidden="true"
      >
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6" />
        <path d="M8 13h8M8 17h6" />
      </svg>
    ),
  },
  {
    title: 'Cheat sheet',
    description:
      'The whole fluent DSL on one printable page. Sources, destinations, validation, errors, MCP, CLI.',
    href: '/cheat-sheet',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={iconClass}
        aria-hidden="true"
      >
        <path d="m9 18 6-6-6-6" />
        <path d="m15 6-6 6 6 6" />
      </svg>
    ),
  },
  {
    title: 'Blog',
    description:
      'Tutorials and field notes. Build your first MCP server, secure it with Clerk or WorkOS, compose capabilities.',
    href: '/blog',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={iconClass}
        aria-hidden="true"
      >
        <path d="M4 4h12a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z" />
        <path d="M18 8h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2" />
        <path d="M8 8h6M8 12h6M8 16h4" />
      </svg>
    ),
  },
  {
    title: 'Examples',
    description:
      'Working capabilities you can fork and extend. File-to-HTTP, scheduled fetchers, MCP tools.',
    href: '/docs/examples',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={iconClass}
        aria-hidden="true"
      >
        <path d="M4.5 14a2.5 2.5 0 0 0 0 5h2v2h4v-7H4.5z" />
        <path d="M11 14h2.5a2.5 2.5 0 0 1 0 5H11" />
        <path d="M19.5 10a2.5 2.5 0 0 0 0-5h-2V3h-4v7h6.5z" />
      </svg>
    ),
  },
  {
    title: 'Adapters',
    description:
      'Every source, destination, and transformer in one list. Cron, HTTP, IMAP, SMTP, MCP, file, channel, direct.',
    href: '/docs/reference/adapters',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={iconClass}
        aria-hidden="true"
      >
        <path d="M9 2v6M15 2v6" />
        <path d="M7 8h10v4a5 5 0 0 1-10 0z" />
        <path d="M12 17v4" />
      </svg>
    ),
  },
]

const changelogHighlight = {
  version: 'v0.6.0',
  title: 'In development',
  description:
    'Mail classification fixes, the new docs blog and cheat-sheet. Tag pending.',
  href: '/docs/changelog',
}

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

// Placeholder customer names. Replace with real customers and unhide
// the TrustedBy section when ready (set hidden=false on the section).
const trustedLogos = [
  'Acme Corp',
  'Globex',
  'Initech',
  'Umbrella',
  'Stark Industries',
  'Wayne Enterprises',
  'Hooli',
  'Pied Piper',
  'Cyberdyne',
  'Tyrell Corp',
]

export default function LandingPage() {
  const featuredPost = getFeaturedPost(getAllBlogPosts())

  return (
    <div className="w-full">
      <LandingHero />
      <ResourceGrid />
      <TrustedBy logos={trustedLogos} />
      <Features />
      {featuredPost && <FeaturedBlogTeaser post={featuredPost} />}
      <FinalCTA />
    </div>
  )
}

function LandingHero() {
  return (
    <section className="relative overflow-hidden">
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
    <section>
      <div className="mx-auto max-w-7xl px-4 pt-24 pb-10 sm:px-6 lg:px-8 lg:pt-28 lg:pb-12">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-medium tracking-tight text-gray-900 sm:text-4xl dark:text-white">
            What&apos;s in Routecraft?
          </h2>
          <p className="mt-3 text-base text-gray-600 dark:text-gray-400">
            Browse the resources you need to build with Routecraft. From the
            API reference and adapters to step-by-step guides and the
            changelog.
          </p>
        </div>
        <div className="mt-12 overflow-hidden rounded-3xl border border-gray-200 dark:border-gray-800">
          <div className="grid grid-cols-1 gap-px bg-gray-200 sm:grid-cols-2 lg:grid-cols-3 dark:bg-gray-800">
            {resourceCards.map((card) => (
              <Link
                key={card.href}
                href={card.href}
                className="group relative flex flex-col gap-3 bg-white p-8 transition hover:bg-gray-50 dark:bg-gray-900 dark:hover:bg-gray-900/60"
              >
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-gray-100 text-gray-700 transition group-hover:bg-sky-100 group-hover:text-sky-600 dark:bg-gray-800 dark:text-gray-300 dark:group-hover:bg-sky-500/10 dark:group-hover:text-sky-400">
                  {card.icon}
                </span>
                <h3 className="mt-6 font-display text-xl font-medium text-gray-900 group-hover:text-sky-600 dark:text-white dark:group-hover:text-sky-300">
                  {card.title}
                </h3>
                <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                  {card.description}
                </p>
              </Link>
            ))}
            <Link
              href={changelogHighlight.href}
              className="group relative flex flex-col justify-between gap-4 bg-sky-50/60 p-8 transition hover:bg-sky-50 dark:bg-sky-500/5 dark:hover:bg-sky-500/10"
            >
              <div>
                <p className="font-display text-xs font-medium text-sky-500">
                  {changelogHighlight.version}
                </p>
                <h3 className="mt-2 font-display text-xl font-medium text-gray-900 group-hover:text-sky-600 dark:text-white dark:group-hover:text-sky-300">
                  {changelogHighlight.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                  {changelogHighlight.description}
                </p>
              </div>
              <span className="inline-flex h-10 w-10 items-center justify-center self-end rounded-full border border-gray-200 bg-white text-gray-700 transition group-hover:border-sky-300 group-hover:bg-sky-100 group-hover:text-sky-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:group-hover:border-sky-500/40 dark:group-hover:bg-sky-500/10 dark:group-hover:text-sky-300">
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-4 w-4 transition group-hover:translate-x-0.5"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z"
                    clipRule="evenodd"
                  />
                </svg>
              </span>
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}

function Features() {
  return (
    <section className="bg-gray-50/60 dark:bg-gray-900/30">
      <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8 lg:py-28">
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
    <section>
      <div className="mx-auto max-w-7xl px-4 pt-24 pb-10 sm:px-6 lg:px-8 lg:pt-28 lg:pb-12">
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
  // Duplicate the list so the marquee can loop seamlessly with translateX(-50%).
  const looped = [...logos, ...logos]
  return (
    <section aria-label="Trusted by" data-trusted-by="placeholder">
      <div className="pt-8 pb-20 lg:pt-10 lg:pb-24">
        <p className="text-center font-display text-sm font-medium text-gray-500 dark:text-gray-400">
          Trusted by teams building with AI
        </p>
        <div
          className="group relative mt-8 overflow-hidden"
          style={{
            maskImage:
              'linear-gradient(to right, transparent, black 8%, black 92%, transparent)',
            WebkitMaskImage:
              'linear-gradient(to right, transparent, black 8%, black 92%, transparent)',
          }}
        >
          <div className="animate-marquee flex w-max gap-16 px-8 group-hover:[animation-play-state:paused]">
            {looped.map((name, i) => (
              <div
                key={`${name}-${i}`}
                aria-hidden={i >= logos.length ? 'true' : undefined}
                className="flex h-12 shrink-0 items-center text-xl font-semibold tracking-tight text-gray-400 transition hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              >
                {name}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function FinalCTA() {
  return (
    <section className="bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto max-w-7xl px-4 pt-10 pb-24 sm:px-6 lg:px-8 lg:pt-12 lg:pb-28">
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
