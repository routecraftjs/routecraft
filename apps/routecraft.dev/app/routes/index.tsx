import { createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { AppLink } from '@/components/AppLink'
import { BlogMark } from '@/components/BlogMark'
import { BlogMeta } from '@/components/BlogMeta'
import { BuiltWithRoutecraft } from '@/components/BuiltWithRoutecraft'
import { Diagram } from '@/components/figures/Diagram'
import { Guardrails } from '@/components/Guardrails'
import { PlatformMedia } from '@/components/PlatformMedia'
import {
  HEADLINE_ITALIC,
  HEADLINE_SOFT,
  SectionHeading,
} from '@/components/SectionHeading'
import { type BlogPostMeta, getAllBlogPosts, getFeaturedPost } from '@/lib/blog'
import { absoluteUrl, docVersion, siteDescription } from '@/lib/site'

const CONSEQUENCES = [
  "Nobody can tell a person's call from an agent's.",
  'Nothing built in one team runs in another.',
  'The tools that matter most are the ones nobody reviewed.',
]

interface Pillar {
  number: string
  title: string
  body: string
}

const PILLARS: Pillar[] = [
  {
    number: '01',
    title: 'Local harness',
    body: 'Build and prove a capability on your own machine, on your own access. Nothing to approve before you try it.',
  },
  {
    number: '02',
    title: 'Team harness',
    body: 'Always on, on service credentials the platform holds and no person does. Every call carries who asked, and telemetry keeps the record.',
  },
  {
    number: '03',
    title: 'Built once, shared by all',
    body: 'Promote a capability when it is proven. Capabilities, skills and agents ship as packages, so every other team installs it instead of building it again.',
  },
  {
    number: '04',
    title: 'Every way in',
    body: 'Your editor, any MCP client, the CLI or plain HTTP. Or on its own, from a schedule, a webhook or an email. When it needs a decision, it asks a person.',
  },
]

const OUTCOMES = [
  'One place your AI tools run',
  'One record of every call',
  'Nothing built twice',
  'People keep the decisions',
]

function LandingPage() {
  const featuredPost = getFeaturedPost(getAllBlogPosts())

  return (
    <main className="relative w-full bg-paper text-ink">
      <PaperGrain />
      <Hero />
      <SectionRule numeral="I" label="The problem" />
      <Problem />
      <SectionRule numeral="II" label="The platform" />
      <Platform />
      <SectionRule numeral="III" label="Bounded by design" />
      <Guardrails />
      <SectionRule numeral="IV" label="The path" />
      <Path />
      <SectionRule numeral="V" label="Two ways in" />
      <TwoModes />
      {featuredPost && (
        <>
          <SectionRule numeral="VI" label="From the blog" />
          <Reading post={featuredPost} />
        </>
      )}
      <BuiltWithRoutecraft />
    </main>
  )
}

function Hero() {
  return (
    <section className="relative">
      <div className="container-page pt-16 pb-20 lg:pt-24 lg:pb-28">
        <div className="max-w-4xl">
          <p
            className="paper-rise font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase"
            style={{ animationDelay: '60ms' }}
          >
            Open source AI capability platform &nbsp;·&nbsp;{' '}
            <AppLink href="/changelog" className="hover:text-cobalt-600">
              v{docVersion}
            </AppLink>
          </p>
          <h1
            className="paper-rise mt-6 font-editorial text-[clamp(3rem,7vw,5.75rem)] leading-[0.98] tracking-[-0.025em] text-ink"
            style={{
              animationDelay: '140ms',
              fontVariationSettings: HEADLINE_SOFT,
            }}
          >
            One team builds it.
            <br />
            <span
              className="font-editorial text-cobalt-500 italic"
              style={{ fontVariationSettings: HEADLINE_ITALIC }}
            >
              Every team runs it.
            </span>
          </h1>

          <p
            className="paper-rise mt-8 max-w-2xl text-[1.15rem] leading-[1.75] text-ink/75"
            style={{ animationDelay: '260ms' }}
          >
            {siteDescription}
          </p>

          <div
            className="paper-rise mt-10 flex flex-wrap items-center gap-x-8 gap-y-4"
            style={{ animationDelay: '360ms' }}
          >
            <a
              href="#platform"
              className="group inline-flex items-center gap-3 bg-cobalt-500 px-6 py-3 text-paper transition hover:bg-cobalt-600"
            >
              <span className="font-mono text-[0.7rem] tracking-[0.22em] uppercase">
                See how it works
              </span>
              <span
                aria-hidden="true"
                className="transition group-hover:translate-y-0.5"
              >
                ↓
              </span>
            </a>
            <AppLink
              href="/docs/introduction/installation"
              className="group relative font-editorial text-[1.05rem] text-ink italic hover:text-cobalt-500"
            >
              <span className="border-b border-current pb-px transition group-hover:border-cobalt-500">
                Get started
              </span>
            </AppLink>
            <a
              href="https://github.com/routecraftjs/routecraft"
              className="group font-mono text-[0.75rem] tracking-[0.18em] text-ink/65 uppercase hover:text-ink"
            >
              GitHub <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

function Problem() {
  return (
    <section>
      <div className="container-page pt-12 pb-20 lg:pt-14 lg:pb-24">
        <SectionHeading
          plain="Every team is building AI tools."
          accent="Alone."
        >
          A script that calls the CRM. A tool that copies a session token out of
          a browser. Skills that work on one laptop. Three teams, three versions
          of the same lookup, each on somebody&apos;s own key.
        </SectionHeading>

        <Diagram id="every-team-builds-its-own" />

        <ul className="grid grid-cols-1 gap-px border border-ink/15 bg-ink/15 md:grid-cols-3">
          {CONSEQUENCES.map((line) => (
            <li
              key={line}
              className="bg-paper px-6 py-6 font-editorial text-[1.2rem] leading-[1.35] text-ink"
              style={{ fontVariationSettings: '"opsz" 72, "SOFT" 50' }}
            >
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-8 max-w-2xl text-[1.05rem] leading-[1.75] text-ink/70">
          Every team wants private AI tools on its own business logic. What they
          lack is a platform to run them on.
        </p>
      </div>
    </section>
  )
}

function Platform() {
  return (
    <section id="platform" className="scroll-mt-20">
      <div className="container-page pt-12 pb-20 lg:pt-14 lg:pb-24">
        <SectionHeading
          plain="One runtime,"
          accent="every way in, the same capabilities everywhere."
        >
          A capability is proven on a laptop, promoted to the team harness, and
          from then on every team, editor and agent calls the same one.
        </SectionHeading>

        <PlatformMedia />

        <div className="grid grid-cols-1 gap-px border border-ink/15 bg-ink/15 sm:grid-cols-2 lg:grid-cols-4">
          {PILLARS.map((pillar) => (
            <article
              key={pillar.number}
              className="flex flex-col gap-3 bg-paper px-6 py-8"
            >
              <header className="flex items-baseline gap-4">
                <span className="font-editorial text-[1.5rem] text-cobalt-500 italic tabular-nums">
                  {pillar.number}
                </span>
                <h3
                  className="font-editorial text-[1.25rem] leading-tight tracking-[-0.005em] text-ink"
                  style={{ fontVariationSettings: '"opsz" 72, "SOFT" 50' }}
                >
                  {pillar.title}
                </h3>
              </header>
              <p className="text-[0.95rem] leading-[1.7] text-ink/70">
                {pillar.body}
              </p>
            </article>
          ))}
        </div>

        <ul className="mt-10 flex flex-wrap gap-x-8 gap-y-3 font-mono text-[0.7rem] tracking-[0.18em] text-ink/65 uppercase">
          {OUTCOMES.map((outcome) => (
            <li key={outcome} className="flex items-center gap-3">
              <span aria-hidden="true" className="h-1.5 w-1.5 bg-cobalt-500" />
              {outcome}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function Path() {
  return (
    <section>
      <div className="container-page pt-12 pb-20 lg:pt-14 lg:pb-24">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <h2
              className="font-editorial text-[clamp(2.5rem,5.5vw,4.5rem)] leading-[1.02] tracking-[-0.025em] text-ink"
              style={{ fontVariationSettings: HEADLINE_SOFT }}
            >
              Start on your laptop.{' '}
              <span
                className="text-cobalt-500 italic"
                style={{ fontVariationSettings: HEADLINE_ITALIC }}
              >
                Promote it when it works.
              </span>
            </h2>
            <p className="mt-6 max-w-2xl text-[1.05rem] leading-[1.75] text-ink/70">
              The first capability runs on your own machine in a minute, and the
              agent you already use can call it. When it earns its place, it
              moves to the team harness and every other team installs it.
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
            <AppLink
              href="/docs/introduction/installation"
              className="group inline-flex items-center gap-2 self-start font-editorial text-[1.05rem] text-ink italic hover:text-cobalt-500 lg:self-end"
            >
              <span>or install locally</span>
              <span
                aria-hidden="true"
                className="transition group-hover:translate-x-1"
              >
                →
              </span>
            </AppLink>
            <div className="inline-flex items-center gap-3 self-start border border-ink/15 bg-paper-deep/40 px-4 py-3 lg:self-end">
              <span className="text-cobalt-500" aria-hidden="true">
                $
              </span>
              <code className="font-mono text-[0.8rem] text-ink">
                bunx create-routecraft my-app
              </code>
            </div>
          </aside>
        </div>
      </div>
    </section>
  )
}

function TwoModes() {
  return (
    <section>
      <div className="container-page pt-12 pb-20 lg:pt-14 lg:pb-24">
        <SectionHeading
          plain="Tools for agents."
          accent="Or the harness itself."
        >
          Most teams start by giving the agents they already use a few governed
          tools. Some go on to run the agent itself on the platform.
        </SectionHeading>

        <div className="mt-12 grid grid-cols-1 gap-px border border-ink/15 bg-ink/15 lg:grid-cols-2">
          <ModeCard
            number="01"
            label="Tools for an agent"
            href="/docs/advanced/expose-as-mcp"
            cta="Expose a capability over MCP"
          >
            Expose a capability over MCP and Claude, Cursor, Copilot, ChatGPT or
            any MCP client can call it, with auth, validation and a record of
            every call.
          </ModeCard>
          <ModeCard
            number="02"
            label="The whole agent"
            href="/docs/reference/adapters/agent/"
            cta="Build an agent capability"
          >
            Run the agent on the platform: you choose the model, the prompt and
            the capabilities it may reach for, and what happens to the result.
          </ModeCard>
        </div>
      </div>
    </section>
  )
}

function ModeCard({
  number,
  label,
  href,
  cta,
  children,
}: {
  number: string
  label: string
  href: string
  cta: string
  children: ReactNode
}) {
  return (
    <article className="flex flex-col gap-5 bg-paper p-7 lg:p-10">
      <header className="flex items-baseline gap-4">
        <span className="font-editorial text-[1.5rem] text-cobalt-500 italic tabular-nums">
          {number}
        </span>
        <p className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase">
          {label}
        </p>
      </header>
      <p className="text-[1rem] leading-[1.7] text-ink/70">{children}</p>
      <AppLink
        href={href}
        className="mt-auto inline-flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase hover:text-cobalt-600"
      >
        <span>{cta}</span>
        <span aria-hidden="true">→</span>
      </AppLink>
    </article>
  )
}

function PaperGrain() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 opacity-[0.04] mix-blend-multiply dark:opacity-[0.06] dark:mix-blend-screen"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.6 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
      }}
    />
  )
}

function SectionRule({ numeral, label }: { numeral?: string; label: string }) {
  return (
    <div className="relative">
      <div className="container-page">
        <div className="flex items-center gap-4">
          <span aria-hidden="true" className="h-1.5 w-1.5 bg-cobalt-500" />
          {numeral && (
            <span className="font-mono text-[0.65rem] tracking-[0.22em] text-cobalt-500 uppercase tabular-nums">
              {numeral}
            </span>
          )}
          <span className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase">
            {label}
          </span>
          <span className="h-px flex-1 bg-ink/15" />
        </div>
      </div>
    </div>
  )
}

function Reading({ post }: { post: BlogPostMeta }) {
  return (
    <section>
      <div className="container-page pt-12 pb-20 lg:pt-14 lg:pb-24">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <header className="lg:col-span-4">
            <h2
              className="font-editorial text-[2.5rem] leading-[1.05] tracking-[-0.02em] text-ink"
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
            <p className="mt-4 max-w-sm text-[1rem] leading-[1.7] text-ink/65">
              Tutorials, postmortems, and small notes from building Routecraft
              in production.
            </p>
            <AppLink
              href="/blog"
              className="group mt-6 inline-flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase hover:text-cobalt-600"
            >
              <span>The full archive</span>
              <span
                aria-hidden="true"
                className="transition group-hover:translate-x-1"
              >
                →
              </span>
            </AppLink>
          </header>

          <AppLink
            href={post.href}
            className="group relative col-span-1 grid grid-cols-1 border-t border-ink/15 lg:col-span-8 lg:grid-cols-[1fr_minmax(0,18rem)]"
          >
            <div className="flex flex-col justify-between py-8 pr-0 lg:pr-10">
              {post.tags && post.tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase">
                  {post.tags.slice(0, 3).map((tag, i) => (
                    <span key={tag} className="inline-flex items-center gap-2">
                      {i > 0 && (
                        <span aria-hidden="true" className="text-ink/25">
                          /
                        </span>
                      )}
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <h3
                className="mt-6 font-editorial text-[2rem] leading-[1.08] tracking-[-0.015em] text-ink transition group-hover:text-cobalt-500 lg:text-[2.3rem]"
                style={{ fontVariationSettings: '"opsz" 144, "SOFT" 40' }}
              >
                {post.title}
              </h3>
              {post.description && (
                <p className="mt-4 max-w-2xl text-[1rem] leading-[1.7] text-ink/70">
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
            <figure className="relative my-0 hidden overflow-hidden border-l border-ink/15 lg:block">
              {post.image ? (
                <img
                  src={post.image}
                  alt={post.imageAlt ?? post.title}
                  className="h-full w-full object-cover grayscale transition duration-700 group-hover:grayscale-0"
                />
              ) : (
                <BlogMark
                  slug={post.slug}
                  tags={post.tags}
                  glyph={post.coverGlyph}
                  diagram={post.diagram}
                />
              )}
            </figure>
          </AppLink>
        </div>
      </div>
    </section>
  )
}

export const Route = createFileRoute('/')({
  head: () => ({
    // Every other route carries its own canonical; without this one the home
    // page is the single URL left to consolidate on its own.
    links: [{ rel: 'canonical', href: absoluteUrl('/') }],
  }),
  component: LandingPage,
})
