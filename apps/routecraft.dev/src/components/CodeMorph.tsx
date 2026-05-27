'use client'

import { Fragment, useEffect, useState } from 'react'
import { Highlight } from 'prism-react-renderer'

interface Pair {
  key: string
  triggerLabel: string
  destLabel: string
  from: string
  to: string
}

const pairs: Pair[] = [
  {
    key: 'cron',
    triggerLabel: 'cron',
    destLabel: 'agent',
    from: "cron('0 9 * * 1-5')",
    to: "agent('eywa')",
  },
  {
    key: 'mcp',
    triggerLabel: 'mcp',
    destLabel: 'mail',
    from: 'mcp()',
    to: 'mail()',
  },
  {
    key: 'webhook',
    triggerLabel: 'webhook',
    destLabel: 'file',
    from: "http({ path: '/brief' })",
    to: "file('./brief.md')",
  },
  {
    key: 'mail',
    triggerLabel: 'mail',
    destLabel: 'direct',
    from: "mail('INBOX', { unseen: true })",
    to: "direct('publish-brief')",
  },
]

const CYCLE_MS = 3400

// The static skeleton. The {from} / {to} placeholders are replaced at
// render time and wrapped in an animated span so the swap is visible.
const SKELETON = `craft()
  .id('morning-brief')
  .from({from})
  .transform(summarise)
  .to({to})`

export function CodeMorph() {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion || paused) return
    const interval = window.setInterval(() => {
      setIndex((i) => (i + 1) % pairs.length)
    }, CYCLE_MS)
    return () => window.clearInterval(interval)
  }, [paused])

  const active = pairs[index]

  return (
    <figure
      className="paper-rise relative"
      style={{ animationDelay: '420ms' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-label="Routecraft capability where the source and destination cycle"
    >
      {/* Backing card: same footprint as the block, offset down-right.
          One shade off the bg, reads like layered paper. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 translate-x-2.5 translate-y-2.5 bg-paper-deep dark:bg-ink-soft"
      />

      {/* Filename header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-b-0 border-ink/20 bg-paper-deep/55 px-5 py-2.5 font-mono text-[0.65rem] tracking-[0.2em] uppercase shadow-[0_20px_40px_-24px_rgba(12,12,16,0.18)] dark:border-paper/20 dark:bg-ink-soft/55 dark:shadow-[0_20px_40px_-24px_rgba(0,0,0,0.6)]">
        <span className="text-ink/60 dark:text-paper/60">morning-brief.ts</span>
        <span key={`hdr-${active.key}`} className="ink-bleed text-cobalt-500">
          {active.triggerLabel} trigger
        </span>
      </div>

      {/* Body */}
      <div className="relative overflow-hidden border border-t-0 border-ink/20 bg-paper-deep/40 px-5 py-6 shadow-[0_20px_40px_-24px_rgba(12,12,16,0.18)] backdrop-blur-sm sm:px-6 sm:py-7 dark:border-paper/20 dark:bg-ink-soft/40 dark:shadow-[0_20px_40px_-24px_rgba(0,0,0,0.6)]">
        <CodeView pair={active} index={index} />
      </div>

      {/* Caption + trigger picker footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-x border-b border-ink/20 bg-paper-deep/55 px-5 py-3 shadow-[0_20px_40px_-24px_rgba(12,12,16,0.18)] dark:border-paper/20 dark:bg-ink-soft/55 dark:shadow-[0_20px_40px_-24px_rgba(0,0,0,0.6)]">
        <span
          className="font-editorial text-[0.95rem] text-ink/65 italic dark:text-paper/65"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 100' }}
        >
          Same body. Different trigger. Change one line.
        </span>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[0.65rem] tracking-[0.2em] uppercase">
          {pairs.map((p, i) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setIndex(i)}
              aria-pressed={i === index}
              className={
                i === index
                  ? 'inline-flex items-center gap-1.5 text-cobalt-500'
                  : 'inline-flex items-center gap-1.5 text-ink/50 transition hover:text-ink dark:text-paper/50 dark:hover:text-paper'
              }
            >
              <span
                aria-hidden="true"
                className={
                  i === index
                    ? 'h-2 w-2 bg-cobalt-500'
                    : 'h-2 w-2 border border-ink/40 dark:border-paper/40'
                }
              />
              <span>{p.triggerLabel}</span>
            </button>
          ))}
        </div>
      </div>
    </figure>
  )
}

function CodeView({ pair, index }: { pair: Pair; index: number }) {
  // We expand the skeleton with sentinel placeholders so prism still
  // tokenises the structure correctly. The placeholders become real
  // strings that we identify on render and replace with animated spans.
  const FROM_SENTINEL = '__FROM__'
  const TO_SENTINEL = '__TO__'
  const code = SKELETON.replace('{from}', FROM_SENTINEL).replace(
    '{to}',
    TO_SENTINEL,
  )

  return (
    <Highlight code={code} language="tsx" theme={{ plain: {}, styles: [] }}>
      {({ className, style, tokens, getTokenProps }) => (
        <pre
          className={
            className +
            ' m-0 grid grid-cols-[auto_1fr] gap-x-4 bg-transparent p-0 font-mono text-[0.8rem] leading-[1.95] sm:text-[0.86rem]'
          }
          style={style}
        >
          {tokens.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              <span
                aria-hidden="true"
                className="text-right font-mono text-[0.7rem] text-ink/30 tabular-nums select-none dark:text-paper/25"
              >
                {lineIndex + 1}
              </span>
              <code className="whitespace-pre">
                {line
                  .filter((token) => !token.empty)
                  .map((token, tokenIndex) => {
                    if (token.content === FROM_SENTINEL) {
                      return (
                        <AnimatedToken key={`${index}-from`} text={pair.from} />
                      )
                    }
                    if (token.content === TO_SENTINEL) {
                      return (
                        <AnimatedToken key={`${index}-to`} text={pair.to} />
                      )
                    }
                    return (
                      <span key={tokenIndex} {...getTokenProps({ token })} />
                    )
                  })}
                {'\n'}
              </code>
            </Fragment>
          ))}
        </pre>
      )}
    </Highlight>
  )
}

function AnimatedToken({ text }: { text: string }) {
  return (
    <span className="ink-bleed inline-block font-mono text-cobalt-500 dark:text-cobalt-300">
      {text}
    </span>
  )
}
