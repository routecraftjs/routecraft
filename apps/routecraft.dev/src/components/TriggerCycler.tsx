'use client'

import { useEffect, useRef, useState } from 'react'

interface Trigger {
  key: string
  label: string
  call: string
}

const triggers: Trigger[] = [
  {
    key: 'cron',
    label: 'Cron',
    call: "cron('0 9 * * 1-5')",
  },
  {
    key: 'mcp',
    label: 'MCP',
    call: 'mcp()',
  },
  {
    key: 'webhook',
    label: 'Webhook',
    call: "http({ path: '/brief' })",
  },
  {
    key: 'mail',
    label: 'Mail',
    call: "mail('INBOX')",
  },
]

const CYCLE_MS = 3400

export function TriggerCycler() {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion || paused) return
    const interval = window.setInterval(() => {
      setIndex((i) => (i + 1) % triggers.length)
    }, CYCLE_MS)
    return () => window.clearInterval(interval)
  }, [paused])

  const active = triggers[index]

  return (
    <figure
      className="paper-rise relative"
      style={{ animationDelay: '420ms' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div
        ref={containerRef}
        className="relative border border-ink/15 bg-paper-deep/40 shadow-[0_30px_80px_-40px_rgba(12,12,16,0.4)] dark:border-paper/15 dark:bg-ink-soft/60 dark:shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7)]"
      >
        <header className="flex items-center justify-between border-b border-ink/10 px-5 py-3 dark:border-paper/10">
          <span className="font-mono text-[0.65rem] tracking-[0.18em] text-ink/55 uppercase dark:text-paper/55">
            morning-brief.ts
          </span>
          <span className="font-mono text-[0.65rem] tracking-[0.18em] text-cobalt-500 uppercase">
            {active.label} trigger
          </span>
        </header>

        <pre className="overflow-x-auto px-5 py-6 font-mono text-[0.82rem] leading-7 text-ink dark:text-paper">
          <code>
            <Line n={1}>
              <span className="text-ink/45 dark:text-paper/45">import</span>
              {' { craft } '}
              <span className="text-ink/45 dark:text-paper/45">from</span>{' '}
              <span className="text-cobalt-600 dark:text-cobalt-300">
                {"'routecraft'"}
              </span>
            </Line>
            <Line n={2}> </Line>
            <Line n={3}>{'craft()'}</Line>
            <Line n={4}>
              {'  .id('}
              <span className="text-cobalt-600 dark:text-cobalt-300">
                {"'morning-brief'"}
              </span>
              {')'}
            </Line>
            <Line n={5}>
              {'  .from('}
              <span
                key={`call-${active.key}`}
                className="ink-bleed inline-block font-medium text-cobalt-500"
              >
                {active.call}
              </span>
              {')'}
            </Line>
            <Line n={6}>{'  .transform(summarise)'}</Line>
            <Line n={7}>
              {'  .to(slack('}
              <span className="text-cobalt-600 dark:text-cobalt-300">
                {"'#standup'"}
              </span>
              {'))'}
            </Line>
          </code>
        </pre>

        <footer className="flex items-center justify-between gap-4 border-t border-ink/10 px-5 py-3 dark:border-paper/10">
          <span className="font-mono text-[0.65rem] tracking-[0.18em] text-ink/55 uppercase dark:text-paper/55">
            Trigger
          </span>
          <ol className="flex items-center gap-4">
            {triggers.map((t, i) => (
              <li key={t.key}>
                <button
                  type="button"
                  onClick={() => setIndex(i)}
                  aria-pressed={i === index}
                  aria-label={`Show ${t.label} trigger`}
                  className="group flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.12em] uppercase"
                >
                  <span
                    aria-hidden="true"
                    className={
                      i === index
                        ? 'h-1.5 w-1.5 bg-cobalt-500'
                        : 'h-1.5 w-1.5 bg-ink/20 transition group-hover:bg-ink/40 dark:bg-paper/20 dark:group-hover:bg-paper/40'
                    }
                  />
                  <span
                    className={
                      i === index
                        ? 'text-cobalt-500'
                        : 'text-ink/55 transition group-hover:text-ink dark:text-paper/55 dark:group-hover:text-paper'
                    }
                  >
                    {t.label}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </footer>
      </div>

      <figcaption
        className="paper-rise mt-6 pl-1 font-editorial text-[0.95rem] text-ink/65 italic dark:text-paper/65"
        style={{ animationDelay: '620ms' }}
      >
        Same body. Different trigger. Change one line.
      </figcaption>
    </figure>
  )
}

function Line({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex">
      <span
        aria-hidden="true"
        className="mr-5 w-4 shrink-0 text-right font-mono text-[0.7rem] text-ink/30 tabular-nums select-none dark:text-paper/30"
      >
        {n}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre">{children}</span>
    </div>
  )
}
