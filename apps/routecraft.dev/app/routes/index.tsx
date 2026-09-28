import { createFileRoute } from '@tanstack/react-router'

import { AppLink } from '@/components/AppLink'
import { BlogMark } from '@/components/BlogMark'
import { BlogMeta } from '@/components/BlogMeta'
import { BuiltWithRoutecraft } from '@/components/BuiltWithRoutecraft'
import {
  FilmPreview,
  FilmProvider,
  WatchFilmButton,
} from '@/components/film/HeroFilm'
import { Diagram } from '@/components/figures/Diagram'
import { Guardrails } from '@/components/Guardrails'
import {
  HEADLINE_ITALIC,
  HEADLINE_SOFT,
  SectionHeading,
} from '@/components/SectionHeading'
import { type BlogPostMeta, getAllBlogPosts, getFeaturedPost } from '@/lib/blog'
import { absoluteUrl, docVersion } from '@/lib/site'

const CONSEQUENCES = [
  'Built again in every team. Reviewed in none.',
  "Every one of them on somebody's personal login.",
  'The day that person leaves, the tool leaves with them.',
]

const COSTS = [
  'Build it once, and every licence you already pay for can call it.',
  'Your AI burns tokens sifting through content instead of solving the problem. A capability answers in one call, the same way every time.',
  'Nothing to replace. Your assistants keep working, with hands.',
]

interface Pillar {
  number: string
  title: string
  body: string
}

const PILLARS: Pillar[] = [
  {
    number: '01',
    title: 'Ship it this afternoon',
    body: 'Build and prove a capability on your own machine, on your own access. No approval, no waiting, nothing to ask for before you try it.',
  },
  {
    number: '02',
    title: 'Run it for everyone',
    body: 'Promote it and it runs always on, on your own infrastructure, on service credentials the platform holds and no person does. Every call carries who asked. Switch telemetry on and every call is on record.',
  },
  {
    number: '03',
    title: 'Never build it twice',
    body: 'Capabilities, skills and agents ship as packages. The next team installs yours instead of writing their own.',
  },
  {
    number: '04',
    title: 'Where your people already work',
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
      <SectionRule numeral="II" label="The cost" />
      <Cost />
      <SectionRule numeral="III" label="The platform" />
      <Platform />
      <SectionRule numeral="IV" label="Bounded by design" />
      <Guardrails />
      <SectionRule numeral="V" label="The path" />
      <Path />
      <BuiltWithRoutecraft />
      {featuredPost && (
        <>
          <SectionRule numeral="VI" label="From the blog" />
          <Reading post={featuredPost} />
        </>
      )}
    </main>
  )
}

function Hero() {
  return (
    <FilmProvider>
      <section className="relative">
        <div className="container-page grid grid-cols-1 items-center gap-x-12 gap-y-12 pt-16 pb-20 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:pt-20 lg:pb-24">
          <div>
            <p
              className="paper-rise font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase"
              style={{ animationDelay: '60ms' }}
            >
              Open source AI automation platform &nbsp;·&nbsp;{' '}
              <AppLink href="/changelog" className="hover:text-cobalt-600">
                v{docVersion}
              </AppLink>
            </p>
            <h1
              className="paper-rise mt-6 font-editorial text-[clamp(3rem,5.2vw,4.75rem)] leading-[0.98] tracking-[-0.025em] text-ink"
              style={{
                animationDelay: '140ms',
                fontVariationSettings: HEADLINE_SOFT,
              }}
            >
              Where your AI{' '}
              <span
                className="font-editorial text-cobalt-500 italic"
                style={{ fontVariationSettings: HEADLINE_ITALIC }}
              >
                gets to work.
              </span>
            </h1>

            <p
              className="paper-rise mt-8 max-w-2xl text-[1.15rem] leading-[1.75] text-ink/75"
              style={{ animationDelay: '260ms' }}
            >
              You bought everyone AI licences. The tools your people built with
              them live on their laptops, on their own logins, and nobody else
              can use them. Your competitors ship capabilities in an afternoon.
              Routecraft is the open source platform where one team builds it
              and every team runs it.
            </p>

            <div
              className="paper-rise mt-10 flex flex-wrap items-center gap-x-8 gap-y-4"
              style={{ animationDelay: '360ms' }}
            >
              <AppLink
                href="/docs/introduction/installation"
                className="group inline-flex items-center gap-3 bg-cobalt-500 px-6 py-3 text-paper transition hover:bg-cobalt-600"
              >
                <span className="font-mono text-[0.7rem] tracking-[0.22em] uppercase">
                  Put your AI to work
                </span>
                <span
                  aria-hidden="true"
                  className="transition group-hover:translate-x-0.5"
                >
                  →
                </span>
              </AppLink>
              <WatchFilmButton className="group relative cursor-pointer font-editorial text-[1.05rem] text-ink italic hover:text-cobalt-500">
                <span className="border-b border-current pb-px transition group-hover:border-cobalt-500">
                  See it in one minute
                </span>
              </WatchFilmButton>
              <a
                href="https://github.com/routecraftjs/routecraft"
                className="group font-mono text-[0.75rem] tracking-[0.18em] text-ink/65 uppercase hover:text-ink"
              >
                GitHub <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
          <div
            className="paper-rise min-w-0"
            style={{ animationDelay: '200ms' }}
          >
            <FilmPreview />
          </div>
        </div>
      </section>
    </FilmProvider>
  )
}

function Problem() {
  return (
    <section>
      <div className="container-page pt-12 pb-20 lg:pt-14 lg:pb-24">
        <SectionHeading
          plain="Your people already built the tools."
          accent="Nobody else can use them."
        >
          Somewhere in your organisation a script already calls the CRM. Down
          the hall another team is writing it again, on a session token copied
          out of a browser. Neither knows the other exists. Both run on
          somebody&apos;s personal login, and both stop the day that person is
          on holiday.
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
          Your people are not short of ideas. They are short of a place to run
          them.
        </p>
      </div>
    </section>
  )
}

function Cost() {
  return (
    <section>
      <div className="container-page pt-12 pb-20 lg:pt-14 lg:pb-24">
        <SectionHeading
          plain="You are paying for the licences."
          accent="You are not getting the work."
        />
        <ul className="mt-10 grid grid-cols-1 gap-px border border-ink/15 bg-ink/15 md:grid-cols-3">
          {COSTS.map((line) => (
            <li
              key={line}
              className="bg-paper px-6 py-6 font-editorial text-[1.2rem] leading-[1.35] text-ink"
              style={{ fontVariationSettings: '"opsz" 72, "SOFT" 50' }}
            >
              {line}
            </li>
          ))}
        </ul>
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
          Prove it on a laptop this afternoon. Promote it, and from tomorrow
          every team, editor and agent in the company calls the same one.
        </SectionHeading>

        <ul className="mt-8 mb-10 flex flex-wrap gap-x-8 gap-y-3 font-mono text-[0.7rem] tracking-[0.18em] text-ink/65 uppercase">
          {OUTCOMES.map((outcome) => (
            <li key={outcome} className="flex items-center gap-3">
              <span aria-hidden="true" className="h-1.5 w-1.5 bg-cobalt-500" />
              {outcome}
            </li>
          ))}
        </ul>

        {/* On a phone the four lines come before the dense picture they explain. */}
        <div className="flex flex-col gap-10">
          <Diagram id="platform" />

          <div className="order-first grid grid-cols-1 gap-px border border-ink/15 bg-ink/15 sm:grid-cols-2 lg:order-none lg:grid-cols-4">
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
        </div>
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
              Your first capability,{' '}
              <span
                className="text-cobalt-500 italic"
                style={{ fontVariationSettings: HEADLINE_ITALIC }}
              >
                before lunch.
              </span>
            </h2>
            <p className="mt-6 max-w-2xl text-[1.05rem] leading-[1.75] text-ink/70">
              One command, and the assistant you already use can call a
              capability you just wrote. When it earns its place, promote it,
              and the next team installs it instead of writing their own.
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
