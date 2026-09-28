import type { CSSProperties } from 'react'

import {
  Chip,
  Conclusion,
  Eyebrow,
  FigureCanvas,
  StoreMark,
} from '@/components/figures/primitives'
import type { FigurePalette } from '@/components/figures/palette'
import type {
  FigureDrawing,
  FigureProps,
  MotifProps,
} from '@/components/figures/types'

const WIDTH = 1600
const HEIGHT = 1000

const MONO = 'var(--font-mono)'
const SANS = 'var(--font-sans)'

/** Pins a board child at a fixed spot on the canvas. */
const at = (left: number, top: number): CSSProperties => ({
  position: 'absolute',
  left,
  top,
})

const PATTERNS = [
  'token pasted into a .env',
  'browser session scraped',
  'one API key for everyone',
  'model keys in the config',
  'expires daily, log in again',
  'no retries, no rate limit',
  'a handful of tests, or none',
  'who called? nobody knows',
  'one author, one laptop',
  'nothing another team can install',
]

interface TeamCard {
  name: string
  /** Absent on a ghost: a build that is not on any list yet. */
  lang?: string
  line: string
  left: number
  top: number
  /** Degrees. Each card sits at its own angle, so the board reads as a pile rather than a grid. */
  tilt: number
  ghost?: boolean
}

const CARDS: TeamCard[] = [
  {
    name: 'invoice-chaser',
    lang: 'Python',
    line: 'one VM, one shared key for everyone',
    left: 358,
    top: 40,
    tilt: -1.5,
  },
  {
    name: 'recruitment-agent',
    lang: 'Node',
    line: "a laptop, a person's token, off on Fridays",
    left: 724,
    top: 102,
    tilt: 1.8,
  },
  {
    name: 'expense-approvals',
    lang: 'Node',
    line: 'logs in as you, copies the session cookie',
    left: 376,
    top: 185,
    tilt: 1.2,
  },
  {
    name: 'support-replies',
    lang: 'Python',
    line: 'its own prompts, its own model key',
    left: 742,
    top: 247,
    tilt: -2,
  },
  {
    name: 'mcp-tools-repo',
    lang: 'TypeScript',
    line: 'works on one machine, nobody can install it',
    left: 362,
    top: 330,
    tilt: -0.8,
  },
  {
    name: 'payroll-checks',
    lang: 'PowerShell',
    line: 'run by hand every Friday, on one login',
    left: 728,
    top: 392,
    tilt: 1.5,
  },
  {
    name: 'copilot-skills',
    lang: 'Markdown',
    line: 'the same GitHub skill, written four times',
    left: 380,
    top: 475,
    tilt: -1.2,
  },
  {
    name: 'sales-followups',
    lang: 'Node',
    line: "reads the CRM on the rep's own login",
    left: 746,
    top: 537,
    tilt: 1.6,
  },
  {
    name: 'the next one',
    line: 'being written this week',
    left: 366,
    top: 620,
    tilt: -1,
    ghost: true,
  },
  {
    name: 'the one in your area',
    line: 'not on any list yet',
    left: 734,
    top: 682,
    tilt: 1.3,
    ghost: true,
  },
]

/** The same business systems the platform figure and the film draw. */
const BACKENDS = [
  'CRM',
  'ERP',
  'HR and payroll',
  'ticketing',
  'knowledge base',
  'mail and calendar',
  'chat',
  'source control',
]

/** Left edge of the backend column, where every wire lands. */
const BACKEND_X = 1058

interface Wire {
  /** Where the wire leaves a card's edge. */
  from: [number, number]
  /** The y of each backend it reaches. */
  to: number[]
  /** A ghost is not wired yet, only guessed at. */
  faint?: boolean
}

const WIRES: Wire[] = [
  { from: [508, 88], to: [178, 256, 412, 89] },
  { from: [874, 150], to: [334, 568, 89] },
  { from: [526, 233], to: [256, 334, 412] },
  { from: [892, 295], to: [89, 178, 646] },
  { from: [512, 378], to: [568, 490, 334] },
  { from: [878, 440], to: [334, 256, 568] },
  { from: [530, 523], to: [724, 490] },
  { from: [896, 585], to: [178, 568, 646] },
  { from: [516, 668], to: [412], faint: true },
  { from: [884, 730], to: [490], faint: true },
]

function Card({ card, palette }: { card: TeamCard; palette: FigurePalette }) {
  const ghost = card.ghost === true
  return (
    <div
      style={{
        ...at(card.left, card.top),
        transform: `rotate(${card.tilt}deg)`,
        width: 300,
        height: 96,
        padding: '12px 14px',
        border: ghost
          ? `1px dashed ${palette.ink40}`
          : `1px solid ${palette.ink35}`,
        background: ghost ? palette.paper : palette.paperDeepSolid,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          whiteSpace: 'nowrap',
          fontFamily: MONO,
          fontSize: '0.86rem',
          fontWeight: ghost ? 500 : 600,
          letterSpacing: '0.02em',
          color: ghost ? palette.ink60 : undefined,
        }}
      >
        <span>{card.name}</span>
        {card.lang && (
          <span
            style={{
              fontFamily: MONO,
              fontSize: '0.64rem',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              border: `1px solid ${palette.ink25}`,
              padding: '3px 8px',
              color: palette.ink60,
              whiteSpace: 'nowrap',
            }}
          >
            {card.lang}
          </span>
        )}
      </div>
      <div
        style={{
          fontFamily: SANS,
          fontSize: '0.85rem',
          lineHeight: 1.35,
          color: palette.ink60,
        }}
      >
        {card.line}
      </div>
    </div>
  )
}

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '64px 72px 56px',
        }}
      >
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          {/* Drawn beneath the cards, so each wire appears to leave a card edge. */}
          <svg
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: '100%',
              height: '100%',
              overflow: 'visible',
              stroke: palette.ink40,
              fill: 'none',
            }}
            strokeWidth={1}
            strokeDasharray="5 5"
          >
            {WIRES.flatMap((wire) =>
              wire.to.map((y) => (
                <line
                  key={`${wire.from.join(',')}-${y}`}
                  x1={wire.from[0]}
                  y1={wire.from[1]}
                  x2={BACKEND_X}
                  y2={y}
                  opacity={wire.faint ? 0.45 : undefined}
                />
              )),
            )}
          </svg>

          <Eyebrow palette={palette} style={at(0, 0)}>
            Seen across these
          </Eyebrow>
          <div
            style={{
              ...at(0, 52),
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 12,
            }}
          >
            {PATTERNS.map((pattern) => (
              <Chip
                key={pattern}
                palette={palette}
                style={{
                  fontSize: '0.88rem',
                  letterSpacing: '0.02em',
                  padding: '8px 14px',
                }}
              >
                {pattern}
              </Chip>
            ))}
          </div>

          {CARDS.map((card) => (
            <Card key={card.name} card={card} palette={palette} />
          ))}

          <div
            style={{
              ...at(BACKEND_X, 52),
              width: 398,
              height: 76,
              border: `1px dashed ${palette.ink40}`,
              background: palette.paper,
              padding: '12px 18px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: 4,
            }}
          >
            <span
              style={{
                fontFamily: MONO,
                fontSize: '0.98rem',
                letterSpacing: '0.04em',
              }}
            >
              a public model API?
            </span>
            <span
              style={{
                fontFamily: SANS,
                fontSize: '0.9rem',
                color: palette.ink55,
              }}
            >
              a key in the config, nobody can tell if it is set
            </span>
          </div>
          <div
            style={{
              ...at(BACKEND_X, 150),
              display: 'flex',
              flexDirection: 'column',
              gap: 22,
            }}
          >
            {BACKENDS.map((backend) => (
              <div
                key={backend}
                style={{
                  width: 340,
                  height: 56,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '0 18px',
                  border: `1px solid ${palette.ink25}`,
                  background: palette.paper,
                  fontFamily: MONO,
                  fontSize: '0.98rem',
                  letterSpacing: '0.04em',
                }}
              >
                <StoreMark colour={palette.ink60} />
                {backend}
              </div>
            ))}
          </div>
        </div>

        <Conclusion
          palette={palette}
          accent="nothing another team can install."
          style={{ marginTop: 24 }}
        >
          Same problem, a stack per team, a credential per person, and
        </Conclusion>
      </div>
    </FigureCanvas>
  )
}

/**
 * Motif: a pile of tilted cards, each wired on its own to the same column of
 * stores. No accent, because the figure shows the problem and not the answer.
 */
function Motif({ palette, size }: MotifProps) {
  const unit = size / 100
  const stroke = Math.max(2, unit * 1.2)
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: unit * 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: unit * 7,
          opacity: 0.7,
        }}
      >
        {[-3, 2.5, -2].map((tilt, i) => (
          <div
            key={tilt}
            style={{
              width: unit * 34,
              height: unit * 13,
              marginLeft: unit * (i % 2) * 6,
              border: `${stroke}px solid ${palette.fg}`,
              transform: `rotate(${tilt}deg)`,
            }}
          />
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: unit * 4 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              width: unit * 26,
              height: unit * 8,
              border: `${Math.max(1, unit * 0.9)}px solid ${palette.muted55}`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

export const everyTeamBuildsItsOwn: FigureDrawing = {
  id: 'every-team-builds-its-own',
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
}
