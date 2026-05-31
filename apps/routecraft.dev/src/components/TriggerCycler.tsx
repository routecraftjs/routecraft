'use client'

import { useEffect, useState } from 'react'

interface Node {
  key: string
  label: string
  call: string
}

const sources: Node[] = [
  { key: 'cron', label: 'cron', call: "cron('0 9 * * 1-5')" },
  { key: 'mcp', label: 'mcp', call: 'mcp()' },
  { key: 'http', label: 'http', call: "http({ path: '/brief' })" },
  { key: 'mail', label: 'mail', call: "mail('INBOX')" },
  { key: 'file', label: 'file', call: "file('./inbox/**/*.csv')" },
  { key: 'timer', label: 'timer', call: 'timer({ every: 60_000 })' },
]

// Destinations are real adapters and displayed in a permuted order so
// every pair crosses rows. Pair semantics:
//   cron   → agent   (row 0 → row 4, ↘ 4)
//   mcp    → file    (row 1 → row 0, ↗ 1)
//   http   → direct  (row 2 → row 3, ↘ 1)
//   mail   → log     (row 3 → row 1, ↗ 2)
//   file   → http    (row 4 → row 5, ↘ 1)
//   timer  → mail    (row 5 → row 2, ↗ 3)
const destinations: Node[] = [
  { key: 'file', label: 'file', call: "file('./brief.md')" },
  { key: 'log', label: 'log', call: 'log()' },
  { key: 'mail', label: 'mail', call: 'mail()' },
  { key: 'direct', label: 'direct', call: "direct('publish-brief')" },
  { key: 'agent', label: 'agent', call: "agent('eywa')" },
  { key: 'http', label: 'http', call: 'http({ url })' },
]

// For source[i], its semantic destination lives at destinations[sourceToDestRow[i]].
const sourceToDestRow = [4, 0, 3, 1, 5, 2]

const CYCLE_MS = 3400

// Layout constants for the SVG schematic.
const W = 720
const H = 400
const BOX_W = 140
const SOURCE_X = 30
const HUB_LEFT_X = 220
const CAP_X = 280
const CAP_W = 160
const HUB_RIGHT_X = 490
const DEST_X = 550
const ROW_GAP = 50
const SOURCES_TOP = 55
const CAP_CY = SOURCES_TOP + (sources.length - 1) * (ROW_GAP / 2)

export function TriggerCycler() {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion || paused) return
    const interval = window.setInterval(() => {
      setIndex((i) => (i + 1) % sources.length)
    }, CYCLE_MS)
    return () => window.clearInterval(interval)
  }, [paused])

  const activeSource = sources[index]
  const activeDestIndex = sourceToDestRow[index]

  return (
    <figure
      className="paper-rise relative"
      style={{ animationDelay: '420ms' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Backing card: same footprint as the block, offset down-right.
          One shade off the bg, reads like layered paper. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 translate-x-2.5 translate-y-2.5 bg-paper-deep"
      />

      {/* Drawing sheet title block */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-b-0 border-ink/20 bg-paper-deep/55 px-4 py-2.5 font-mono text-[0.65rem] tracking-[0.2em] text-ink/55 uppercase shadow-[0_20px_40px_-24px_rgba(12,12,16,0.18)] dark:shadow-[0_20px_40px_-24px_rgba(0,0,0,0.6)]">
        <span>
          <span className="text-cobalt-500">Fig. 01</span> — Trigger topology
        </span>
        <span>
          Active:{' '}
          <span className="text-cobalt-500">
            {activeSource.label} → {destinations[activeDestIndex].label}
          </span>
        </span>
      </div>

      <div className="border border-t-0 border-ink/20 bg-paper-deep/40 shadow-[0_20px_40px_-24px_rgba(12,12,16,0.18)] backdrop-blur-sm dark:shadow-[0_20px_40px_-24px_rgba(0,0,0,0.6)]">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full"
          aria-label="Trigger topology diagram"
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-ink" />
            </marker>
            <marker
              id="arrow-active"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-cobalt-500" />
            </marker>
          </defs>

          {/* Column labels */}
          <text
            x={SOURCE_X}
            y={36}
            className="fill-ink/55 font-mono text-[10px] tracking-[0.2em] uppercase"
          >
            sources
          </text>
          <text
            x={DEST_X + BOX_W}
            y={36}
            textAnchor="end"
            className="fill-ink/55 font-mono text-[10px] tracking-[0.2em] uppercase"
          >
            destinations
          </text>

          {/* Source boxes */}
          {sources.map((t, i) => {
            const cy = SOURCES_TOP + i * ROW_GAP
            const isActive = i === index
            return (
              <g
                key={`src-${t.key}`}
                className="cursor-pointer"
                onClick={() => setIndex(i)}
              >
                <rect
                  x={SOURCE_X}
                  y={cy - 16}
                  width={BOX_W}
                  height={32}
                  fill="none"
                  className={isActive ? 'stroke-cobalt-500' : 'stroke-ink/30'}
                  strokeWidth={isActive ? 1.5 : 1}
                />
                {isActive && (
                  <rect
                    x={SOURCE_X}
                    y={cy - 16}
                    width={BOX_W}
                    height={32}
                    className="fill-cobalt-500/8"
                  />
                )}
                <text
                  x={SOURCE_X + 10}
                  y={cy - 3}
                  className={
                    isActive
                      ? 'fill-cobalt-500 font-mono text-[11px] font-semibold'
                      : 'fill-ink/70 font-mono text-[11px]'
                  }
                >
                  {t.label}
                </text>
                <text
                  x={SOURCE_X + 10}
                  y={cy + 10}
                  className={
                    isActive
                      ? 'fill-cobalt-500/85 font-mono text-[9px]'
                      : 'fill-ink/45 font-mono text-[9px]'
                  }
                >
                  {t.call}
                </text>
              </g>
            )
          })}

          {/* Destination boxes */}
          {destinations.map((d, i) => {
            const cy = SOURCES_TOP + i * ROW_GAP
            const isActive = i === activeDestIndex
            // Find which source pairs with this destination so clicking it
            // selects the corresponding pair.
            const sourceIndex = sourceToDestRow.indexOf(i)
            return (
              <g
                key={`dst-${d.key}`}
                className="cursor-pointer"
                onClick={() => sourceIndex !== -1 && setIndex(sourceIndex)}
              >
                <rect
                  x={DEST_X}
                  y={cy - 16}
                  width={BOX_W}
                  height={32}
                  fill="none"
                  className={isActive ? 'stroke-cobalt-500' : 'stroke-ink/30'}
                  strokeWidth={isActive ? 1.5 : 1}
                />
                {isActive && (
                  <rect
                    x={DEST_X}
                    y={cy - 16}
                    width={BOX_W}
                    height={32}
                    className="fill-cobalt-500/8"
                  />
                )}
                <text
                  x={DEST_X + BOX_W - 10}
                  y={cy - 3}
                  textAnchor="end"
                  className={
                    isActive
                      ? 'fill-cobalt-500 font-mono text-[11px] font-semibold'
                      : 'fill-ink/70 font-mono text-[11px]'
                  }
                >
                  {d.label}
                </text>
                <text
                  x={DEST_X + BOX_W - 10}
                  y={cy + 10}
                  textAnchor="end"
                  className={
                    isActive
                      ? 'fill-cobalt-500/85 font-mono text-[9px]'
                      : 'fill-ink/45 font-mono text-[9px]'
                  }
                >
                  {d.call}
                </text>
              </g>
            )
          })}

          {/* Connection lines from each source into the left hub */}
          {sources.map((t, i) => {
            const cy = SOURCES_TOP + i * ROW_GAP
            const isActive = i === index
            return (
              <line
                key={`src-conn-${t.key}`}
                x1={SOURCE_X + BOX_W}
                y1={cy}
                x2={HUB_LEFT_X}
                y2={CAP_CY}
                className={isActive ? 'stroke-cobalt-500' : 'stroke-ink/15'}
                strokeWidth={isActive ? 1.5 : 0.75}
                strokeDasharray={isActive ? '0' : '3 3'}
              />
            )
          })}

          {/* Connection lines from the right hub out to each destination */}
          {destinations.map((d, i) => {
            const cy = SOURCES_TOP + i * ROW_GAP
            const isActive = i === activeDestIndex
            return (
              <line
                key={`dst-conn-${d.key}`}
                x1={HUB_RIGHT_X}
                y1={CAP_CY}
                x2={DEST_X}
                y2={cy}
                className={isActive ? 'stroke-cobalt-500' : 'stroke-ink/15'}
                strokeWidth={isActive ? 1.5 : 0.75}
                strokeDasharray={isActive ? '0' : '3 3'}
              />
            )
          })}

          {/* Left hub junction */}
          <circle
            cx={HUB_LEFT_X}
            cy={CAP_CY}
            r={3.5}
            className="fill-cobalt-500"
          />

          {/* Left hub → capability arrow */}
          <line
            x1={HUB_LEFT_X + 4}
            y1={CAP_CY}
            x2={CAP_X - 4}
            y2={CAP_CY}
            className="stroke-cobalt-500"
            strokeWidth="1.5"
            markerEnd="url(#arrow-active)"
          />

          {/* Capability box */}
          <g>
            <rect
              x={CAP_X}
              y={CAP_CY - 28}
              width={CAP_W}
              height={56}
              fill="none"
              strokeWidth="1.25"
              className="stroke-ink"
            />
            <line
              x1={CAP_X}
              y1={CAP_CY - 12}
              x2={CAP_X + CAP_W}
              y2={CAP_CY - 12}
              strokeWidth="0.75"
              className="stroke-ink/30"
            />
            <text
              x={CAP_X + CAP_W / 2}
              y={CAP_CY - 18}
              textAnchor="middle"
              className="fill-ink/55 font-mono text-[9px] tracking-[0.2em] uppercase"
            >
              capability
            </text>
            <text
              x={CAP_X + CAP_W / 2}
              y={CAP_CY + 3}
              textAnchor="middle"
              className="fill-ink font-mono text-[12px] font-semibold"
            >
              morning-brief
            </text>
            <text
              x={CAP_X + CAP_W / 2}
              y={CAP_CY + 18}
              textAnchor="middle"
              className="fill-ink/55 font-mono text-[9px]"
            >
              .transform(summarise)
            </text>
          </g>

          {/* Capability → right hub arrow */}
          <line
            x1={CAP_X + CAP_W + 4}
            y1={CAP_CY}
            x2={HUB_RIGHT_X - 4}
            y2={CAP_CY}
            className="stroke-cobalt-500"
            strokeWidth="1.5"
            markerEnd="url(#arrow-active)"
          />

          {/* Right hub junction */}
          <circle
            cx={HUB_RIGHT_X}
            cy={CAP_CY}
            r={3.5}
            className="fill-cobalt-500"
          />

          {/* Dimension line at bottom */}
          <g className="stroke-ink/40" strokeWidth="0.6">
            <line x1={SOURCE_X} y1={H - 30} x2={DEST_X + BOX_W} y2={H - 30} />
            <line x1={SOURCE_X} y1={H - 34} x2={SOURCE_X} y2={H - 26} />
            <line
              x1={DEST_X + BOX_W}
              y1={H - 34}
              x2={DEST_X + BOX_W}
              y2={H - 26}
            />
          </g>
          <text
            x={(SOURCE_X + DEST_X + BOX_W) / 2}
            y={H - 18}
            textAnchor="middle"
            className="fill-ink/55 font-mono text-[9px] tracking-[0.2em] uppercase"
          >
            one capability · every trigger
          </text>
        </svg>
      </div>

      {/* Drawing sheet footer with trigger picker */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-x border-b border-ink/20 bg-paper-deep/55 px-4 py-2.5 font-mono text-[0.7rem] tracking-[0.16em] uppercase shadow-[0_20px_40px_-24px_rgba(12,12,16,0.18)] dark:shadow-[0_20px_40px_-24px_rgba(0,0,0,0.6)]">
        <span className="text-ink/55">trigger:</span>
        <div className="flex flex-wrap items-center gap-2">
          {sources.map((t, i) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setIndex(i)}
              aria-pressed={i === index}
              className={
                i === index
                  ? 'flex items-center gap-1.5 text-cobalt-500'
                  : 'flex items-center gap-1.5 text-ink/55 transition hover:text-ink'
              }
            >
              <span
                aria-hidden="true"
                className={
                  i === index
                    ? 'h-1.5 w-1.5 bg-cobalt-500'
                    : 'h-1.5 w-1.5 border border-ink/40'
                }
              />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>
    </figure>
  )
}
