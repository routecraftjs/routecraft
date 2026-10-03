import { Highlight } from 'prism-react-renderer'
import { Fragment } from 'react'

import { AppLink } from '@/components/AppLink'
import { Diagram } from '@/components/figures/Diagram'
import { SectionHeading } from '@/components/SectionHeading'
import { useChannelHref } from '@/lib/docs-channel-context'

const CAPABILITY = `// One of the hands the agent can reach for.
craft()
  .id('publishBrief')
  .input(BriefInput)
  .authorize({ roles: ['editor'] })
  .from(direct())
  .transform(redactPII)
  .to(http({ url: '/feed' }))`

/**
 * The safety argument, told once: the agent is handed named capabilities, the
 * capability runs where the agent is not, and the credential never leaves the
 * platform. One figure and one capability, not a comparison of SDKs.
 */
export function Guardrails() {
  const exposeHref = useChannelHref('/docs/introduction/expose-to-an-agent')
  return (
    <section>
      <div className="container-page pt-12 pb-20 lg:pt-14 lg:pb-24">
        <SectionHeading plain="Hands," accent="not keys.">
          Agents have deleted production databases trying to be helpful. On
          Routecraft the agent is given capabilities, not credentials. Each one
          does one thing, says who may call it, and runs where the agent is not,
          on credentials the platform holds. The agent reaches exactly the
          capabilities your team exposes to it, and nothing else.
        </SectionHeading>

        <div className="mt-6 grid grid-cols-1 gap-x-12 lg:grid-cols-2 lg:items-center">
          <Diagram id="hands-not-keys" />
          {/* min-w-0: a grid item defaults to min-width:auto, so the unwrappable
              code would otherwise drag the page into a horizontal scroll. */}
          <div className="min-w-0">
            <CodeBlock code={CAPABILITY} />
            <p className="mt-4 font-editorial text-[0.92rem] text-ink/60 italic">
              The capability is the boundary. What you expose is all the agent
              can reach.
            </p>
          </div>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
          <p
            className="font-editorial text-[1.05rem] leading-[1.65] text-ink/70 italic"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 100' }}
          >
            You review the <span className="not-italic">capability</span>, not
            the <span className="not-italic">prompt</span>. A prompt is a
            request. A capability is a decision, and it stays decided.
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 lg:justify-end">
            <AppLink
              href={exposeHref}
              className="group inline-flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase hover:text-cobalt-600"
            >
              <span>Give your agent hands</span>
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

function CodeBlock({ code }: { code: string }) {
  return (
    <div
      // The code cannot wrap, so on a narrow card the overflow has to be
      // reachable rather than pushing the card wider than the viewport. A
      // scroll container holding nothing focusable is unreachable by keyboard,
      // so it is its own tab stop with a visible focus ring.
      tabIndex={0}
      role="region"
      aria-label="Code sample"
      className="scrollbar-quiet overflow-x-auto border border-ink/15 bg-paper-deep/40 px-4 py-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt-500"
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
