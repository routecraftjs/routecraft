import Link from 'next/link'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { BlogMeta } from '@/components/BlogMeta'
import { CodeMorph } from '@/components/CodeMorph'
import { HomeAdapters } from '@/components/HomeAdapters'
import { type BlogPostMeta, getAllBlogPosts, getFeaturedPost } from '@/lib/blog'

export const metadata: Metadata = {
  title: 'Routecraft - AI automation as code',
  description:
    'Type-safe framework for AI automation. Build the tools an agent uses, or the agent itself, with the same fluent DSL.',
}

const changelogHighlight = {
  version: 'v0.6.0',
  title: 'In development',
  description:
    'Mail classification fixes, the new docs blog and cheat-sheet. Tag pending.',
  href: '/docs/changelog',
}

interface Feature {
  number: string
  title: string
  description: string
}

const features: Feature[] = [
  {
    number: '01',
    title: 'Type-safe end to end',
    description:
      'Types flow through every operation. The body shape at .to() is inferred from .from() and every transform in between.',
  },
  {
    number: '02',
    title: 'One DSL, every trigger',
    description:
      'Cron, webhook, MCP, IMAP, channel, file. Swap one line to change how a capability is invoked. The business logic is unchanged.',
  },
  {
    number: '03',
    title: 'Native MCP integration',
    description:
      'Set the source to mcp() and the capability becomes an MCP tool that Claude Desktop, Cursor, and any MCP client can call.',
  },
  {
    number: '04',
    title: 'Standard Schema validation',
    description:
      'Bring Zod, Valibot, ArkType, or anything that speaks Standard Schema. Inputs validate before your code runs.',
  },
  {
    number: '05',
    title: 'Auth as a primitive',
    description:
      'jwks() verifies bearer tokens. .authorize({ roles }) gates capabilities. userinfo hydrates the principal from your IdP.',
  },
  {
    number: '06',
    title: 'Compose capabilities',
    description:
      'direct() lets one capability call another with full type safety. Build a graph, test each node in isolation.',
  },
  {
    number: '07',
    title: 'Structured logging',
    description:
      'Every step emits structured events. Pipe them to your log aggregator, or watch them live in the built-in TUI.',
  },
  {
    number: '08',
    title: 'Plugin system',
    description:
      'Telemetry, AI, mail, custom adapters. Plugins extend the runtime without forking it.',
  },
  {
    number: '09',
    title: 'Runs on Bun or Node',
    description:
      'The CLI runs TypeScript directly on Bun. Embed in any Node 22+ app via ContextBuilder.',
  },
]

export default function LandingPage() {
  const featuredPost = getFeaturedPost(getAllBlogPosts())

  return (
    <div className="relative w-full bg-paper text-ink dark:bg-ink dark:text-paper">
      <PaperGrain />
      <Hero />
      <SectionRule numeral="I" label="Two ways to ship agents" />
      <TwoModes />
      <SectionRule numeral="II" label="What you can wire up" />
      <HomeAdapters />
      <SectionRule numeral="III" label="Why Routecraft" />
      <Thesis />
      {featuredPost && (
        <>
          <SectionRule numeral="IV" label="From the blog" />
          <Reading post={featuredPost} />
        </>
      )}
      <SectionRule numeral="V" label="Try it" />
      <Finale />
    </div>
  )
}

function PaperGrain() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 opacity-[0.035] mix-blend-multiply dark:opacity-[0.06] dark:mix-blend-screen"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.6 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
      }}
    />
  )
}

function Hero() {
  return (
    <section className="relative">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-x-12 gap-y-16 px-4 pt-16 pb-20 sm:px-6 lg:grid-cols-12 lg:px-8 lg:pt-24 lg:pb-28">
        <div className="lg:col-span-6 lg:pr-4">
          <p
            className="paper-rise font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase"
            style={{ animationDelay: '60ms' }}
          >
            A TypeScript framework &nbsp;·&nbsp;{' '}
            <Link
              href={changelogHighlight.href}
              className="hover:text-cobalt-600 dark:hover:text-cobalt-300"
            >
              {changelogHighlight.version} in dev
            </Link>
          </p>
          <h1
            className="paper-rise mt-6 font-editorial text-[clamp(3rem,7vw,5.75rem)] leading-[0.98] tracking-[-0.025em] text-ink dark:text-paper"
            style={{
              animationDelay: '140ms',
              fontVariationSettings: '"opsz" 144, "SOFT" 30',
            }}
          >
            Tools for agents.
            <br />
            <span
              className="font-editorial italic"
              style={{ fontVariationSettings: '"opsz" 144, "SOFT" 100' }}
            >
              Or
            </span>{' '}
            <span
              className="font-editorial italic"
              style={{ fontVariationSettings: '"opsz" 144, "SOFT" 100' }}
            >
              the whole
            </span>{' '}
            <span
              className="font-editorial text-cobalt-500 italic"
              style={{ fontVariationSettings: '"opsz" 144, "SOFT" 100' }}
            >
              agent.
            </span>
          </h1>

          <p
            className="paper-rise mt-8 max-w-xl text-[1.1rem] leading-[1.75] text-ink/75 dark:text-paper/75"
            style={{ animationDelay: '260ms' }}
          >
            Type-safe framework for AI automation. Build the tools an agent
            uses, or the agent itself, with the same fluent DSL.
          </p>

          <div
            className="paper-rise mt-10 flex flex-wrap items-center gap-x-8 gap-y-4"
            style={{ animationDelay: '360ms' }}
          >
            <Link
              href="/docs/introduction/installation"
              className="group inline-flex items-center gap-3 bg-cobalt-500 px-6 py-3 text-paper transition hover:bg-cobalt-600"
            >
              <span className="font-mono text-[0.7rem] tracking-[0.22em] uppercase">
                Get started
              </span>
              <span
                aria-hidden="true"
                className="transition group-hover:translate-x-1"
              >
                →
              </span>
            </Link>
            <Link
              href="/cheat-sheet"
              className="group relative font-editorial text-[1.05rem] text-ink italic hover:text-cobalt-500 dark:text-paper dark:hover:text-cobalt-300"
            >
              <span className="border-b border-current pb-px transition group-hover:border-cobalt-500 dark:group-hover:border-cobalt-300">
                Read the cheat sheet
              </span>
            </Link>
            <a
              href="https://github.com/routecraftjs/routecraft"
              className="group font-mono text-[0.75rem] tracking-[0.18em] text-ink/65 uppercase hover:text-ink dark:text-paper/65 dark:hover:text-paper"
            >
              GitHub <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>

        <div className="lg:col-span-6">
          <CodeMorph />
        </div>
      </div>
    </section>
  )
}

function SectionRule({ numeral, label }: { numeral?: string; label: string }) {
  return (
    <div className="relative">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-4">
          <span aria-hidden="true" className="h-1.5 w-1.5 bg-cobalt-500" />
          {numeral && (
            <span className="font-mono text-[0.65rem] tracking-[0.22em] text-cobalt-500 uppercase tabular-nums">
              {numeral}
            </span>
          )}
          <span className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase dark:text-paper/55">
            {label}
          </span>
          <span className="h-px flex-1 bg-ink/15 dark:bg-paper/15" />
        </div>
      </div>
    </div>
  )
}

function TwoModes() {
  return (
    <section>
      <div className="mx-auto max-w-7xl px-4 pt-12 pb-20 sm:px-6 lg:px-8 lg:pt-14 lg:pb-24">
        <header className="max-w-3xl">
          <h2
            className="font-editorial text-[2.5rem] leading-[1.05] tracking-[-0.02em] text-ink dark:text-paper"
            style={{ fontVariationSettings: '"opsz" 144, "SOFT" 30' }}
          >
            Use Routecraft on{' '}
            <span
              className="text-cobalt-500 italic"
              style={{ fontVariationSettings: '"opsz" 144, "SOFT" 100' }}
            >
              either side
            </span>{' '}
            of the agent.
          </h2>
          <p className="mt-5 max-w-2xl text-[1.05rem] leading-[1.75] text-ink/70 dark:text-paper/70">
            The same fluent DSL builds the tools an agent calls, and the harness
            that runs an agent. You pick which side you are on. Sometimes both,
            in the same project.
          </p>
        </header>

        <div className="mt-12 grid grid-cols-1 gap-px border border-ink/15 bg-ink/15 lg:grid-cols-2 dark:border-paper/15 dark:bg-paper/15">
          <article className="relative flex flex-col gap-5 bg-paper p-7 lg:p-10 dark:bg-ink">
            <header className="flex items-baseline gap-4">
              <span className="font-editorial text-[1.5rem] text-cobalt-500 italic tabular-nums">
                01
              </span>
              <p className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase dark:text-paper/55">
                Tools for an agent
              </p>
            </header>
            <h3
              className="font-editorial text-[1.85rem] leading-[1.1] tracking-[-0.015em] text-ink dark:text-paper"
              style={{ fontVariationSettings: '"opsz" 96, "SOFT" 50' }}
            >
              Expose capabilities,{' '}
              <span
                className="text-cobalt-500 italic"
                style={{ fontVariationSettings: '"opsz" 96, "SOFT" 100' }}
              >
                let agents call them.
              </span>
            </h3>
            <p className="text-[1rem] leading-[1.7] text-ink/70 dark:text-paper/70">
              Set the source to <InlineMono>mcp()</InlineMono> and your
              capability becomes an MCP tool. Claude Desktop, Cursor, ChatGPT,
              OpenClaw, Hermes, or any MCP-speaking client can pick it up. Auth,
              validation, and structured output are part of the primitive.
            </p>
            <ul className="mt-2 flex flex-col gap-2 font-mono text-[0.8rem] text-ink/75 dark:text-paper/75">
              <li className="flex items-baseline gap-3">
                <span className="text-cobalt-500" aria-hidden="true">
                  ▸
                </span>
                <span>
                  <span className="text-cobalt-600 dark:text-cobalt-300">
                    .from(mcp())
                  </span>{' '}
                  exposes a typed tool
                </span>
              </li>
              <li className="flex items-baseline gap-3">
                <span className="text-cobalt-500" aria-hidden="true">
                  ▸
                </span>
                <span>
                  <span className="text-cobalt-600 dark:text-cobalt-300">
                    .input(schema)
                  </span>{' '}
                  validates before your code runs
                </span>
              </li>
              <li className="flex items-baseline gap-3">
                <span className="text-cobalt-500" aria-hidden="true">
                  ▸
                </span>
                <span>
                  <span className="text-cobalt-600 dark:text-cobalt-300">
                    .authorize(&#123; roles &#125;)
                  </span>{' '}
                  gates per-agent
                </span>
              </li>
            </ul>
            <Link
              href="/docs/advanced/expose-as-mcp"
              className="mt-3 inline-flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase hover:text-cobalt-600 dark:hover:text-cobalt-300"
            >
              <span>Expose a capability over MCP</span>
              <span aria-hidden="true">→</span>
            </Link>
          </article>

          <article className="relative flex flex-col gap-5 bg-paper p-7 lg:p-10 dark:bg-ink">
            <header className="flex items-baseline gap-4">
              <span className="font-editorial text-[1.5rem] text-cobalt-500 italic tabular-nums">
                02
              </span>
              <p className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase dark:text-paper/55">
                The whole agent
              </p>
            </header>
            <h3
              className="font-editorial text-[1.85rem] leading-[1.1] tracking-[-0.015em] text-ink dark:text-paper"
              style={{ fontVariationSettings: '"opsz" 96, "SOFT" 50' }}
            >
              Build the harness.{' '}
              <span
                className="text-cobalt-500 italic"
                style={{ fontVariationSettings: '"opsz" 96, "SOFT" 100' }}
              >
                Own the loop.
              </span>
            </h3>
            <p className="text-[1rem] leading-[1.7] text-ink/70 dark:text-paper/70">
              Set the destination to <InlineMono>agent()</InlineMono> and the
              capability becomes the brain. You choose the model, the system
              prompt, the tools the agent can reach for, and what happens to the
              result. The DSL is the harness.
            </p>
            <ul className="mt-2 flex flex-col gap-2 font-mono text-[0.8rem] text-ink/75 dark:text-paper/75">
              <li className="flex items-baseline gap-3">
                <span className="text-cobalt-500" aria-hidden="true">
                  ▸
                </span>
                <span>
                  <span className="text-cobalt-600 dark:text-cobalt-300">
                    .to(agent(&#123; model, system &#125;))
                  </span>{' '}
                  picks the model
                </span>
              </li>
              <li className="flex items-baseline gap-3">
                <span className="text-cobalt-500" aria-hidden="true">
                  ▸
                </span>
                <span>
                  <span className="text-cobalt-600 dark:text-cobalt-300">
                    tools([...])
                  </span>{' '}
                  scopes what the agent can do
                </span>
              </li>
              <li className="flex items-baseline gap-3">
                <span className="text-cobalt-500" aria-hidden="true">
                  ▸
                </span>
                <span>
                  <span className="text-cobalt-600 dark:text-cobalt-300">
                    .to(direct(&apos;next&apos;))
                  </span>{' '}
                  composes into longer flows
                </span>
              </li>
            </ul>
            <Link
              href="/docs/advanced/composing-capabilities"
              className="mt-3 inline-flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase hover:text-cobalt-600 dark:hover:text-cobalt-300"
            >
              <span>Build an agent capability</span>
              <span aria-hidden="true">→</span>
            </Link>
          </article>
        </div>
      </div>
    </section>
  )
}

function InlineMono({ children }: { children: ReactNode }) {
  return (
    <code className="border border-ink/15 bg-paper-deep/60 px-1.5 py-0.5 font-mono text-[0.9em] text-cobalt-600 dark:border-paper/15 dark:bg-ink-soft/60 dark:text-cobalt-300">
      {children}
    </code>
  )
}

function Thesis() {
  return (
    <section>
      <div className="mx-auto max-w-7xl px-4 pt-12 pb-20 sm:px-6 lg:px-8 lg:pt-14 lg:pb-24">
        <header className="mx-auto max-w-4xl text-center">
          <p className="font-mono text-[0.65rem] tracking-[0.22em] text-cobalt-500 uppercase">
            Thesis
          </p>
          <blockquote
            className="mt-6 font-editorial text-[clamp(2rem,4.2vw,3.25rem)] leading-[1.08] tracking-[-0.02em] text-ink dark:text-paper"
            style={{ fontVariationSettings: '"opsz" 144, "SOFT" 30' }}
          >
            <span className="text-cobalt-500/35" aria-hidden="true">
              &ldquo;
            </span>
            The shape of a capability does{' '}
            <span
              className="text-cobalt-500 italic"
              style={{ fontVariationSettings: '"opsz" 144, "SOFT" 100' }}
            >
              not change
            </span>{' '}
            when you change how it is triggered.
            <span className="text-cobalt-500/35" aria-hidden="true">
              &rdquo;
            </span>
          </blockquote>
          <p className="mx-auto mt-5 max-w-xl text-[1.05rem] leading-[1.75] text-ink/65 dark:text-paper/65">
            Nine reasons that holds. Pull out any one and the code still
            compiles. Pull them all together and you have Routecraft.
          </p>
        </header>

        <div className="mt-14 grid grid-cols-1 gap-px border border-ink/15 bg-ink/15 sm:grid-cols-2 lg:grid-cols-3 dark:border-paper/15 dark:bg-paper/15">
          {features.map((f) => (
            <article
              key={f.number}
              className="group relative flex flex-col gap-3 bg-paper px-6 py-8 transition hover:bg-paper-deep/40 dark:bg-ink dark:hover:bg-ink-soft/40"
            >
              <header className="flex items-baseline gap-4">
                <span className="font-editorial text-[1.5rem] text-cobalt-500 italic tabular-nums">
                  {f.number}
                </span>
                <h3
                  className="font-editorial text-[1.25rem] leading-tight tracking-[-0.005em] text-ink dark:text-paper"
                  style={{ fontVariationSettings: '"opsz" 72, "SOFT" 50' }}
                >
                  {f.title}
                </h3>
              </header>
              <p className="text-[0.95rem] leading-[1.7] text-ink/70 dark:text-paper/70">
                {f.description}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function Reading({ post }: { post: BlogPostMeta }) {
  return (
    <section>
      <div className="mx-auto max-w-7xl px-4 pt-12 pb-20 sm:px-6 lg:px-8 lg:pt-14 lg:pb-24">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <header className="lg:col-span-4">
            <h2
              className="font-editorial text-[2.5rem] leading-[1.05] tracking-[-0.02em] text-ink dark:text-paper"
              style={{ fontVariationSettings: '"opsz" 144, "SOFT" 30' }}
            >
              From the{' '}
              <span
                className="text-cobalt-500 italic"
                style={{ fontVariationSettings: '"opsz" 144, "SOFT" 100' }}
              >
                field.
              </span>
            </h2>
            <p className="mt-4 max-w-sm text-[1rem] leading-[1.7] text-ink/65 dark:text-paper/65">
              Tutorials, postmortems, and small notes from building Routecraft
              in production.
            </p>
            <Link
              href="/blog"
              className="group mt-6 inline-flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase hover:text-cobalt-600 dark:hover:text-cobalt-300"
            >
              <span>The full archive</span>
              <span
                aria-hidden="true"
                className="transition group-hover:translate-x-1"
              >
                →
              </span>
            </Link>
          </header>

          <Link
            href={post.href}
            className="group relative col-span-1 grid grid-cols-1 border-t border-ink/15 lg:col-span-8 lg:grid-cols-[1fr_minmax(0,18rem)] dark:border-paper/15"
          >
            <div className="flex flex-col justify-between py-8 pr-0 lg:pr-10">
              {post.tags && post.tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase dark:text-paper/55">
                  {post.tags.slice(0, 3).map((tag, i) => (
                    <span key={tag} className="inline-flex items-center gap-2">
                      {i > 0 && (
                        <span
                          aria-hidden="true"
                          className="text-ink/25 dark:text-paper/25"
                        >
                          /
                        </span>
                      )}
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <h3
                className="mt-6 font-editorial text-[2rem] leading-[1.08] tracking-[-0.015em] text-ink transition group-hover:text-cobalt-500 lg:text-[2.3rem] dark:text-paper dark:group-hover:text-cobalt-300"
                style={{ fontVariationSettings: '"opsz" 144, "SOFT" 40' }}
              >
                {post.title}
              </h3>
              {post.description && (
                <p className="mt-4 max-w-2xl text-[1rem] leading-[1.7] text-ink/70 dark:text-paper/70">
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
              <span className="mt-8 inline-flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase">
                Read the post
                <span
                  aria-hidden="true"
                  className="transition group-hover:translate-x-1"
                >
                  →
                </span>
              </span>
            </div>
            <figure className="relative my-0 hidden border-l border-ink/15 lg:flex lg:items-center lg:justify-center dark:border-paper/15">
              {post.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={post.image}
                  alt={post.imageAlt ?? ''}
                  className="h-full w-full object-cover grayscale transition duration-700 group-hover:grayscale-0"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="font-editorial text-[10rem] leading-none text-cobalt-500/15 dark:text-cobalt-400/20"
                  style={{ fontVariationSettings: '"opsz" 144, "SOFT" 100' }}
                >
                  {post.title.charAt(0)}
                </span>
              )}
            </figure>
          </Link>
        </div>
      </div>
    </section>
  )
}

function Finale() {
  return (
    <section>
      <div className="mx-auto max-w-7xl px-4 pt-12 pb-28 sm:px-6 lg:px-8 lg:pt-14 lg:pb-32">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <h2
              className="font-editorial text-[clamp(2.5rem,5.5vw,4.5rem)] leading-[1.02] tracking-[-0.025em] text-ink dark:text-paper"
              style={{ fontVariationSettings: '"opsz" 144, "SOFT" 30' }}
            >
              Open the playground.{' '}
              <span
                className="text-cobalt-500 italic"
                style={{ fontVariationSettings: '"opsz" 144, "SOFT" 100' }}
              >
                Have an MCP server in thirty seconds.
              </span>
            </h2>
            <p className="mt-6 max-w-2xl text-[1.05rem] leading-[1.75] text-ink/70 dark:text-paper/70">
              Run it in GitHub Codespaces without leaving your browser. Or
              scaffold locally and have it humming on your laptop in the same
              minute.
            </p>
          </div>
          <aside className="flex flex-col gap-6 lg:col-span-4 lg:items-end lg:text-right">
            <a
              href="https://codespaces.new/routecraftjs/craft-playground"
              className="group inline-flex items-center gap-3 self-start bg-cobalt-500 px-6 py-3 text-paper transition hover:bg-cobalt-600 lg:self-end"
            >
              <span className="font-mono text-[0.7rem] tracking-[0.22em] uppercase">
                Open the playground
              </span>
              <span
                aria-hidden="true"
                className="transition group-hover:translate-x-1"
              >
                →
              </span>
            </a>
            <Link
              href="/docs/introduction/installation"
              className="group inline-flex items-center gap-2 self-start font-editorial text-[1.05rem] text-ink italic hover:text-cobalt-500 lg:self-end dark:text-paper dark:hover:text-cobalt-300"
            >
              <span>or install locally</span>
              <span
                aria-hidden="true"
                className="transition group-hover:translate-x-1"
              >
                →
              </span>
            </Link>
            <div className="inline-flex items-center gap-3 self-start border border-ink/15 bg-paper-deep/40 px-4 py-3 lg:self-end dark:border-paper/15 dark:bg-ink-soft/40">
              <span className="text-cobalt-500" aria-hidden="true">
                $
              </span>
              <code className="font-mono text-[0.8rem] text-ink dark:text-paper">
                bunx create-routecraft my-app
              </code>
            </div>
          </aside>
        </div>
      </div>
    </section>
  )
}
