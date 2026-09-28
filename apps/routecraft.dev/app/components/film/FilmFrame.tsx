import type { CSSProperties, ReactNode } from 'react'

import {
  BEATS,
  FILM_WIDTH,
  FILM_HEIGHT,
  clamp01,
  mix,
  ramp,
  span,
} from './timeline'

const PAPER = 'var(--color-paper, #f5f1e8)'
const DEEP = 'var(--color-paper-deep, #ebe5da)'
const INK = 'var(--color-ink, #22232c)'
const BLUE = 'var(--color-cobalt-500, #1247ff)'
const SERIF = 'var(--font-fraunces, Georgia, serif)'
const SANS = 'var(--font-ibm-plex-sans, system-ui, sans-serif)'
const MONO = 'var(--font-jetbrains-mono, ui-monospace, monospace)'
const ink = (n: number) => `color-mix(in srgb, ${INK} ${n}%, transparent)`
const paper = (n: number) => `color-mix(in srgb, ${PAPER} ${n}%, transparent)`
const rect = (x: number, y: number, w: number, h?: number): CSSProperties => ({
  position: 'absolute',
  left: x,
  top: y,
  width: w,
  ...(h ? { height: h } : {}),
})
const display: CSSProperties = {
  fontFamily: SERIF,
  fontVariationSettings: '"opsz" 144, "SOFT" 30',
  letterSpacing: '-0.025em',
  lineHeight: 1.12,
}

function Accent({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        color: BLUE,
        fontStyle: 'italic',
        fontVariationSettings: '"opsz" 144, "SOFT" 100',
      }}
    >
      {children}
    </span>
  )
}

function Mark({ size = 42 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M125 175H75V125L125 175ZM175 175H125V125L175 175ZM125 25C152.614 25 175 47.3858 175 75C175 102.614 152.614 125 125 125V75H75L125 125H75L25 75V25H125Z" />
    </svg>
  )
}

function Eyebrow({
  children,
  style,
}: {
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 26,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function Headline({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div style={rect(120, 148, 1680)}>
      <div style={{ ...display, fontSize: 82 }}>{children}</div>
      {sub && (
        <div style={{ marginTop: 24, fontSize: 34, color: ink(75) }}>{sub}</div>
      )}
    </div>
  )
}

function Chip({
  children,
  dark = false,
  active = false,
}: {
  children: ReactNode
  dark?: boolean
  active?: boolean
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 22px',
        background: active ? BLUE : dark ? paper(10) : DEEP,
        color: active || dark ? PAPER : INK,
        fontSize: 28,
        border: `1px solid ${dark ? paper(25) : ink(15)}`,
      }}
    >
      {children}
    </span>
  )
}

/** One named object follows the entire journey. Its identity never changes. */
function Capability({
  x,
  y,
  w,
  success = false,
  opacity = 1,
}: {
  x: number
  y: number
  w: number
  success?: boolean
  opacity?: number
}) {
  return (
    <div
      style={{
        ...rect(x, y, w, 228),
        boxSizing: 'border-box',
        padding: '30px 34px',
        background: PAPER,
        color: INK,
        border: `2px solid ${BLUE}`,
        boxShadow: '0 12px 40px #22232c0c',
        opacity,
      }}
    >
      <Eyebrow style={{ color: BLUE, fontSize: 24 }}>
        Capability <span style={{ float: 'right' }}>v1</span>
      </Eyebrow>
      <div style={{ ...display, fontSize: 51, marginTop: 20 }}>
        Find overdue invoices
      </div>
      <div style={{ marginTop: 22, fontSize: 28, color: ink(75) }}>
        {success
          ? '✓ 12 overdue invoices returned'
          : 'Read invoices → Filter → Return results'}
      </div>
    </div>
  )
}

function Connector({
  x1,
  y1,
  x2,
  y2,
  p,
  back = false,
}: {
  x1: number
  y1: number
  x2: number
  y2: number
  p: number
  back?: boolean
}) {
  const progress = clamp01(p)
  if (!progress) return null
  const x = mix(x1, x2, progress)
  const y = mix(y1, y2, progress)
  const a = Math.atan2(y2 - y1, x2 - x1)
  return (
    <svg
      width={FILM_WIDTH}
      height={FILM_HEIGHT}
      style={{ position: 'absolute', inset: 0 }}
    >
      <path
        d={`M${x1} ${y1} L${x} ${y}`}
        fill="none"
        stroke={back ? ink(45) : BLUE}
        strokeWidth={3}
        strokeDasharray={back ? '9 9' : undefined}
      />
      <path
        d={`M${x - 16 * Math.cos(a - 0.5)} ${y - 16 * Math.sin(a - 0.5)} L${x} ${y} L${x - 16 * Math.cos(a + 0.5)} ${y - 16 * Math.sin(a + 0.5)}`}
        fill="none"
        stroke={back ? ink(45) : BLUE}
        strokeWidth={3}
      />
      {!back && <circle cx={x} cy={y} r={6} fill={BLUE} />}
    </svg>
  )
}

function Problem({ t }: { t: number }) {
  const opacity = span(t, 0, 12.15, 0.45)
  if (!opacity) return null
  const duplicated = ramp(t, 6.2, 0.7)
  return (
    <div style={{ opacity }}>
      <Headline sub="Scripts on laptops. Access tied to people.">
        Useful AI tools. <Accent>Fragmented work.</Accent>
      </Headline>
      {[
        { team: 'Finance', file: 'overdue.py', note: 'On one laptop', at: 1.2 },
        {
          team: 'Sales',
          file: 'invoices.ts',
          note: 'A personal login',
          at: 2.2,
        },
        {
          team: 'Operations',
          file: 'invoice-prompt.md',
          note: 'Another copy',
          at: 3.2,
        },
      ].map((card, i) => {
        const p = ramp(t, card.at, 0.6)
        return (
          <div
            key={card.team}
            style={{
              ...rect(120 + i * 580, 416 + (i % 2) * 24, 520, 304),
              padding: 34,
              boxSizing: 'border-box',
              background: DEEP,
              border: `1px solid ${ink(20)}`,
              opacity: p,
              transform: `translateY(${24 * (1 - p)}px) rotate(${(i - 1) * 1.2}deg)`,
            }}
          >
            <Eyebrow style={{ color: ink(70) }}>{card.team}</Eyebrow>
            <div style={{ fontFamily: MONO, fontSize: 32, marginTop: 35 }}>
              {card.file}
            </div>
            <div style={{ fontSize: 29, marginTop: 25, color: ink(65) }}>
              {card.note}
            </div>
            <div
              style={{
                fontSize: 28,
                color: BLUE,
                marginTop: 23,
                opacity: duplicated,
              }}
            >
              Find overdue invoices
            </div>
          </div>
        )
      })}
      <div
        style={{
          ...rect(120, 817, 1680),
          borderTop: `2px solid ${ink(20)}`,
          paddingTop: 34,
          opacity: duplicated,
        }}
      >
        <span style={{ ...display, fontSize: 51 }}>
          The same job. <Accent>Built three times.</Accent>
        </span>
      </div>
    </div>
  )
}

function Introduction({ t }: { t: number }) {
  const opacity = span(t, 12, 19.55, 0.45)
  if (!opacity) return null
  return (
    <div
      style={{
        opacity,
        transform: `translateY(${20 * (1 - ramp(t, 12, 0.7))}px)`,
      }}
    >
      <div
        style={{
          ...rect(120, 252, 1600),
          display: 'flex',
          alignItems: 'center',
          gap: 28,
        }}
      >
        <Mark size={130} />
        <span style={{ ...display, fontSize: 132 }}>Routecraft</span>
      </div>
      <div style={{ ...rect(130, 450, 1600), ...display, fontSize: 91 }}>
        Build AI capabilities.
        <br />
        <Accent>Run them. Reuse them.</Accent>
      </div>
      <div style={{ ...rect(132, 735, 1500), fontSize: 36, color: ink(75) }}>
        Open source framework · TypeScript · Your infrastructure
      </div>
    </div>
  )
}

function Build({ t }: { t: number }) {
  const opacity = span(t, BEATS.build, 27, 0.35)
  if (!opacity) return null
  const ready = ramp(t, 24.3, 0.5)
  return (
    <div style={{ opacity }}>
      <Headline sub="Start with one useful action.">
        Build it locally. <Accent>Prove it works.</Accent>
      </Headline>
      <div
        style={{
          ...rect(120, 376, 865, 440),
          background: DEEP,
          border: `1px solid ${ink(20)}`,
        }}
      >
        <Eyebrow style={{ position: 'absolute', left: 38, top: 35 }}>
          Your laptop
        </Eyebrow>
        <Capability x={38} y={113} w={789} success={ready > 0.5} />
        <div
          style={{
            ...rect(38, 361, 790),
            fontSize: 28,
            color: BLUE,
            opacity: ready,
          }}
        >
          ✓ Tested with sample invoices
        </div>
      </div>
      <div
        style={{
          ...rect(1060, 376, 740, 440),
          background: INK,
          color: PAPER,
          boxSizing: 'border-box',
          padding: 35,
        }}
      >
        <Eyebrow style={{ fontSize: 24, color: paper(70) }}>
          Your TypeScript
        </Eyebrow>
        <pre
          style={{
            fontFamily: MONO,
            fontSize: 29,
            lineHeight: 1.65,
            margin: '30px 0 0',
            whiteSpace: 'pre-wrap',
          }}
        >{`craft()\n  .id('find-overdue-invoices')\n  .from(direct())\n  .to(http({ url: invoicesApi }))\n  .transform(findOverdue)`}</pre>
      </div>
      <div style={{ ...rect(120, 882, 1680), fontSize: 31, color: ink(70) }}>
        One named capability. Inputs, logic and access rules in code.
      </div>
    </div>
  )
}

function Deploy({ t }: { t: number }) {
  const opacity = span(t, BEATS.deploy, 33.8, 0.35)
  if (!opacity) return null
  const p = ramp(t, 27.6, 1.5)
  return (
    <div style={{ opacity }}>
      <Headline sub="Deploy the capability with the controls your teams need.">
        Ready for <Accent>shared use.</Accent>
      </Headline>
      <div
        style={{
          ...rect(120, 411, 490, 350),
          boxSizing: 'border-box',
          border: `2px solid ${ink(25)}`,
          padding: 36,
        }}
      >
        <Eyebrow>Your laptop</Eyebrow>
        <div style={{ ...display, fontSize: 44, marginTop: 48 }}>
          Built.
          <br />
          Tested.
          <br />
          <span style={{ color: BLUE }}>Ready to deploy.</span>
        </div>
      </div>
      <Connector x1={634} y1={573} x2={865} y2={573} p={p} />
      <div
        style={{
          ...rect(890, 361, 910, 450),
          background: INK,
          color: PAPER,
          padding: 36,
          boxSizing: 'border-box',
        }}
      >
        <Eyebrow>Shared Routecraft runtime</Eyebrow>
        <div style={{ marginTop: 15, color: paper(70), fontSize: 30 }}>
          On your infrastructure
        </div>
      </div>
      <Capability
        x={mix(153, 928, p)}
        y={mix(487, 519, p)}
        w={mix(760, 834, p)}
        opacity={p}
      />
      <div
        style={{
          ...rect(120, 866, 1680),
          display: 'flex',
          gap: 24,
          opacity: ramp(t, 29.8, 0.6),
        }}
      >
        <Chip>Service account</Chip>
        <Chip>Access: Finance + Sales</Chip>
        <Chip>Rules you control</Chip>
      </div>
    </div>
  )
}

function Reuse({ t }: { t: number }) {
  const opacity = span(t, BEATS.finance, 50.6, 0.35)
  if (!opacity) return null
  const audit = ramp(t, BEATS.telemetry, 0.5)
  const runtimeY = 371
  const runtimeH = mix(430, 318, audit)
  const capabilityY = mix(496, 448, audit)
  const callers = [
    { name: 'Finance', via: 'Agent · MCP', at: BEATS.finance, y: 371 },
    { name: 'Sales', via: 'Editor · MCP', at: BEATS.sales, y: 554 },
    {
      name: 'Daily report',
      via: 'Schedule · 09:00',
      at: BEATS.schedule,
      y: 737,
    },
  ]
  return (
    <div style={{ opacity }}>
      <Headline
        sub={
          audit > 0.5
            ? 'Telemetry enabled. Each invocation carries its caller.'
            : 'Different ways in. One shared capability.'
        }
      >
        {audit > 0.5 ? (
          <>
            See who called it. <Accent>See what happened.</Accent>
          </>
        ) : (
          <>
            Build once. <Accent>Use it across teams.</Accent>
          </>
        )}
      </Headline>
      {callers.map((c) => {
        const p = ramp(t, c.at + 0.15, 0.5)
        const flow = ramp(t, c.at + 0.7, 0.8)
        return (
          <div key={c.name} style={{ opacity: p }}>
            <div
              style={{
                ...rect(120, c.y, 440, 139),
                background: DEEP,
                boxSizing: 'border-box',
                padding: '23px 30px',
                border: `1px solid ${ink(20)}`,
              }}
            >
              <div style={{ ...display, fontSize: 41 }}>{c.name}</div>
              <div style={{ fontSize: 28, marginTop: 11, color: ink(70) }}>
                {c.via}
              </div>
            </div>
            <Connector
              x1={578}
              y1={c.y + 53}
              x2={784}
              y2={runtimeY + 190}
              p={flow}
            />
          </div>
        )
      })}
      <div
        style={{
          ...rect(808, runtimeY, 992, runtimeH),
          background: INK,
          color: PAPER,
        }}
      >
        <div style={{ ...rect(35, 26, 920), fontSize: 29 }}>
          Shared Routecraft runtime{' '}
          <span style={{ float: 'right', color: paper(65) }}>v1</span>
        </div>
      </div>
      <Capability x={842} y={capabilityY} w={924} success={t > 35} />
      <div
        style={{
          ...rect(846, 761, 910),
          fontSize: 28,
          color: PAPER,
          opacity: 1 - audit,
        }}
      >
        Same code · Same rules · Service account
      </div>
      <div
        style={{
          ...rect(808, 716, 992, 239),
          background: DEEP,
          border: `1px solid ${ink(20)}`,
          boxSizing: 'border-box',
          padding: 28,
          opacity: audit,
        }}
      >
        <Eyebrow style={{ color: BLUE, fontSize: 23 }}>
          Telemetry on · Invocation record
        </Eyebrow>
        {[
          '09:14  Finance / Ana     12 invoices · OK',
          '09:16  Sales / Sam       12 invoices · OK',
          '09:00  Daily report      12 invoices · OK',
        ].map((line, i) => (
          <div
            key={line}
            style={{
              fontFamily: MONO,
              fontSize: 27,
              marginTop: 20,
              whiteSpace: 'pre',
              opacity: ramp(t, 46 + i * 0.7, 0.4),
            }}
          >
            {line}
          </div>
        ))}
      </div>
      <div style={{ ...rect(120, 950, 620), fontSize: 23, color: ink(55) }}>
        Illustrative workflow and results
      </div>
    </div>
  )
}

function Payoff({ t }: { t: number }) {
  const opacity = span(t, BEATS.payoff, 55.5, 0.45)
  if (!opacity) return null
  return (
    <div style={{ opacity }}>
      <div
        style={{
          ...rect(120, 172, 1680),
          ...display,
          fontSize: 88,
          textAlign: 'center',
        }}
      >
        What one team <Accent>proves,</Accent>
        <br />
        every team can use.
      </div>
      <Capability x={533} y={466} w={854} />
      <div
        style={{
          ...rect(360, 798, 1200),
          display: 'flex',
          gap: 28,
          justifyContent: 'center',
        }}
      >
        <Chip active>Finance</Chip>
        <Chip active>Sales</Chip>
        <Chip active>Scheduled work</Chip>
      </div>
      <div
        style={{
          ...rect(120, 913, 1680),
          textAlign: 'center',
          fontSize: 32,
          color: ink(70),
        }}
      >
        Shared capability. Controlled access. No duplicated integration.
      </div>
    </div>
  )
}

function EndCard({ t }: { t: number }) {
  const opacity = ramp(t, BEATS.end, 0.6)
  if (!opacity) return null
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        opacity,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 30 }}>
        <Mark size={140} />
        <span style={{ ...display, fontSize: 140 }}>Routecraft</span>
      </div>
      <div style={{ ...display, marginTop: 36, fontSize: 69 }}>
        Built to be <Accent>used.</Accent>
      </div>
      <div style={{ fontSize: 35, color: ink(70), marginTop: 42 }}>
        Open source AI automation framework
      </div>
      <div
        style={{
          marginTop: 72,
          fontSize: 38,
          color: BLUE,
          borderBottom: `2px solid ${BLUE}`,
          paddingBottom: 12,
        }}
      >
        Try your first capability at routecraft.dev →
      </div>
    </div>
  )
}

/** Pure rendering keeps export and the homepage player on the same timeline. */
export function FilmFrame({ t }: { t: number }) {
  return (
    <div
      style={{
        position: 'relative',
        width: FILM_WIDTH,
        height: FILM_HEIGHT,
        overflow: 'hidden',
        background: PAPER,
        color: INK,
        fontFamily: SANS,
      }}
    >
      <div
        style={{
          ...rect(120, 58, 1680),
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          opacity: 1 - ramp(t, 55, 0.3),
        }}
      >
        <Mark size={36} />
        <span style={{ ...display, fontSize: 33 }}>Routecraft</span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: MONO,
            fontSize: 21,
            letterSpacing: '0.08em',
            color: ink(55),
          }}
        >
          BUILD · RUN · REUSE
        </span>
      </div>
      <Problem t={t} />
      <Introduction t={t} />
      <Build t={t} />
      <Deploy t={t} />
      <Reuse t={t} />
      <Payoff t={t} />
      <EndCard t={t} />
      <div
        style={{
          position: 'absolute',
          left: 120,
          right: 120,
          bottom: 39,
          height: 2,
          background: ink(12),
          opacity: 1 - ramp(t, 55, 0.3),
        }}
      >
        <div
          style={{
            height: 2,
            width: `${Math.min(100, (t / 55) * 100)}%`,
            background: BLUE,
          }}
        />
      </div>
    </div>
  )
}
