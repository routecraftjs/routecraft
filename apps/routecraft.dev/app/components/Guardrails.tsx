import { AppLink } from '@/components/AppLink'
import { Fragment } from 'react'
import { Highlight } from 'prism-react-renderer'

const DANGEROUS = `// Typical agent SDK setup
const agent = new Agent({
  tools: [
    bashTool(),
    browserUse({ allowAll: true }),
    computerUse({ allowAll: true })
  ],
})

// The agent decides what to run.
// Including DROP TABLE, rm -rf,
// or leaking the connection string.`

const BOUNDED = `// A capability that drives the agent.
craft()
  .id('triage-inbox')
  .from(mail('INBOX'))
  .to(agent({
    model: 'anthropic:claude-sonnet-4-6',
    system: 'Triage and route inbound support mail.',
    tools: tools(['Direct(publishBrief)', 'Direct(sendDigest)']),
  }))

// One of the bounded hands the agent can reach for.
craft()
  .id('publishBrief')
  .input(BriefInput)
  .authorize({ roles: ['editor'] })
  .from(direct())
  .transform(redactPII)
  .to(http({ url: '/feed' }))`

export function Guardrails() {
  return (
    <section>
      <div className="mx-auto max-w-7xl px-4 pt-12 pb-20 sm:px-6 lg:px-8 lg:pt-14 lg:pb-24">
        <header className="max-w-3xl">
          <h2
            className="font-editorial text-[2.5rem] leading-[1.05] tracking-[-0.02em] text-ink"
            style={{ fontVariationSettings: '"opsz" 144, "SOFT" 30' }}
          >
            Hands,{' '}
            <span
              className="text-cobalt-500 italic"
              style={{ fontVariationSettings: '"opsz" 144, "SOFT" 100' }}
            >
              not keys.
            </span>
          </h2>
          <p className="mt-5 max-w-2xl text-[1.05rem] leading-[1.75] text-ink/70">
            Agents have deleted production databases trying to do their job.
            Routecraft capabilities are bounded by design: typed inputs,
            authorize(), per-tool guards, the same code in test and prod. The
            agent gets the hands you choose, not the keyring.
          </p>
        </header>

        <div className="mt-12 grid grid-cols-1 gap-px border border-ink/15 bg-ink/15 lg:grid-cols-2">
          {/* min-w-0: a grid item defaults to min-width:auto, so without it the
              column grows to the widest unwrappable code line and drags the
              whole page into a horizontal scroll on a phone. */}
          <article className="relative flex min-w-0 flex-col gap-5 bg-paper p-7 lg:p-10">
            <header className="flex items-baseline gap-3">
              <span
                aria-hidden="true"
                className="font-mono text-[0.9rem] text-ink/40"
              >
                01
              </span>
              <p className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase line-through decoration-ink/40">
                The keyring
              </p>
            </header>
            <h3
              className="font-editorial text-[1.5rem] leading-[1.15] tracking-[-0.01em] text-ink/75"
              style={{ fontVariationSettings: '"opsz" 96, "SOFT" 50' }}
            >
              Hand the agent raw tools and hope for the best.
            </h3>
            <CodeBlock code={DANGEROUS} muted />
            <p className="font-editorial text-[0.92rem] text-ink/60 italic">
              One bad prompt away from a production incident.
            </p>
          </article>

          {/* min-w-0: a grid item defaults to min-width:auto, so without it the
              column grows to the widest unwrappable code line and drags the
              whole page into a horizontal scroll on a phone. */}
          <article className="relative flex min-w-0 flex-col gap-5 bg-paper p-7 lg:p-10">
            <header className="flex items-baseline gap-3">
              <span
                aria-hidden="true"
                className="font-mono text-[0.9rem] text-cobalt-500"
              >
                02
              </span>
              <p className="font-mono text-[0.65rem] tracking-[0.22em] text-cobalt-500 uppercase">
                The hands you authored
              </p>
            </header>
            <h3
              className="font-editorial text-[1.5rem] leading-[1.15] tracking-[-0.01em] text-ink"
              style={{ fontVariationSettings: '"opsz" 96, "SOFT" 50' }}
            >
              Give the agent named capabilities and nothing else.
            </h3>
            <CodeBlock code={BOUNDED} />
            <p className="font-editorial text-[0.92rem] text-ink/60 italic">
              The capability is the boundary. The agent has no other surface.
            </p>
          </article>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
          <p
            className="font-editorial text-[1.05rem] leading-[1.65] text-ink/70 italic"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 100' }}
          >
            The DSL is simple enough that an LLM can write the capability for
            you. You review the <span className="not-italic">capability</span>,
            not the <span className="not-italic">prompt</span>.
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 lg:justify-end">
            <AppLink
              href="/docs/advanced/expose-as-mcp"
              className="group inline-flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase hover:text-cobalt-600"
            >
              <span>Expose to an agent</span>
              <span
                aria-hidden="true"
                className="transition group-hover:translate-x-1"
              >
                →
              </span>
            </AppLink>
          </div>
        </div>
      </div>
    </section>
  )
}

function CodeBlock({ code, muted }: { code: string; muted?: boolean }) {
  return (
    <div
      // The code cannot wrap, so on a narrow card the overflow has to be
      // reachable rather than pushing the card wider than the viewport. A
      // scroll container holding nothing focusable is unreachable by keyboard,
      // so it is its own tab stop with a visible focus ring.
      tabIndex={0}
      role="region"
      aria-label="Code sample"
      className={
        'overflow-x-auto border border-ink/15 bg-paper-deep/40 px-4 py-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt-500 ' +
        (muted ? 'opacity-70' : '')
      }
    >
      <Highlight code={code} language="tsx" theme={{ plain: {}, styles: [] }}>
        {({ className, style, tokens, getTokenProps }) => (
          <pre
            className={
              className +
              ' m-0 bg-transparent p-0 font-mono text-[0.78rem] leading-[1.7] sm:text-[0.82rem]'
            }
            style={style}
          >
            <code>
              {tokens.map((line, lineIndex) => (
                <Fragment key={lineIndex}>
                  {line
                    .filter((token) => !token.empty)
                    .map((token, tokenIndex) => (
                      <span key={tokenIndex} {...getTokenProps({ token })} />
                    ))}
                  {'\n'}
                </Fragment>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  )
}
