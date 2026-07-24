import {
  AccentItalic,
  Body,
  FigureCanvas,
  Subhead,
} from '@/components/figures/primitives'
import type { FigurePalette } from '@/components/figures/palette'
import type {
  FigureDefinition,
  FigureProps,
  MotifProps,
} from '@/components/figures/types'

const WIDTH = 1280
const HEIGHT = 1080

interface Rung {
  n: number
  title: string
  body: string
  /** The rung the post argues you should be standing on. */
  highlight?: boolean
  /** The rung most teams are actually standing on. */
  youAreHere?: boolean
}

// Top of the figure is the top of the ladder, so the list runs 5 down to 1.
const RUNGS: Rung[] = [
  {
    n: 5,
    title: 'Organisational agents',
    body: 'Shared workers anyone can invoke · audit trail.',
  },
  {
    n: 4,
    title: 'Deployed capabilities',
    body: 'Centrally deployed · SSO in front · service accounts behind.',
    highlight: true,
  },
  {
    n: 3,
    title: 'Local tools',
    body: 'Tool servers on each laptop · personal credentials.',
  },
  {
    n: 2,
    title: 'Skills & agents repo',
    body: 'Versioned instructions · no hands.',
    youAreHere: true,
  },
  { n: 1, title: 'Prompt library', body: 'Snippets in a wiki.' },
]

function Rung({ rung, palette }: { rung: Rung; palette: FigurePalette }) {
  return (
    <div
      style={{
        gridColumn: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        padding: '0 30px',
        position: 'relative',
        border: rung.highlight
          ? `2px solid ${palette.accent}`
          : `1px solid ${palette.ink25}`,
        background: rung.highlight ? palette.accent06 : undefined,
      }}
    >
      <AccentItalic palette={palette} size="2rem" style={{ width: 40 }}>
        {rung.n}
      </AccentItalic>
      <div>
        <Subhead
          palette={palette}
          accent={rung.highlight}
          style={{ whiteSpace: 'nowrap' }}
        >
          {rung.title}
        </Subhead>
        <Body palette={palette}>{rung.body}</Body>
      </div>
      {rung.youAreHere && (
        <span
          style={{
            position: 'absolute',
            right: 26,
            top: '50%',
            transform: 'translateY(-50%)',
            fontFamily: 'var(--font-mono)',
            fontSize: '1rem',
            letterSpacing: '0.1em',
            color: palette.accent,
          }}
        >
          ▸ you are here
        </span>
      )}
    </div>
  )
}

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT} markTop={54}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '64px 72px',
        }}
      >
        <h3
          style={{
            margin: 0,
            fontFamily: 'var(--font-editorial)',
            fontWeight: 600,
            fontSize: '2.8rem',
            lineHeight: 1.04,
            letterSpacing: '-0.02em',
            fontVariationSettings: '"opsz" 144, "SOFT" 0',
          }}
        >
          The maturity{' '}
          <AccentItalic palette={palette} size="2.8rem">
            ladder.
          </AccentItalic>
        </h3>

        <div
          style={{
            marginTop: 40,
            flex: 1,
            display: 'grid',
            gridTemplateColumns: '1fr 360px',
            gridTemplateRows: 'repeat(5, 1fr)',
            gap: '16px 28px',
          }}
        >
          {RUNGS.map((rung) => (
            <Rung key={rung.n} rung={rung} palette={palette} />
          ))}

          {/* Bracket across rungs 4 to 2: the climb the post is about. */}
          <div
            style={{
              gridColumn: 2,
              gridRow: '2 / 5',
              display: 'flex',
              alignItems: 'center',
              gap: 18,
            }}
          >
            <div
              style={{
                width: 14,
                alignSelf: 'stretch',
                border: `2px solid ${palette.accent}`,
                borderLeft: 'none',
              }}
            />
            <Body
              palette={palette}
              size="1.45rem"
              style={{ color: palette.ink }}
            >
              The jump that matters:
              <br />
              <AccentItalic palette={palette} size="1.45rem">
                identity + deployment,
              </AccentItalic>{' '}
              not AI.
            </Body>
          </div>
        </div>
      </div>
    </FigureCanvas>
  )
}

/**
 * Motif: the ladder as a staircase, each rung stepping right as it rises. Rung
 * 4 is the accented one, so the artwork carries the post's claim about where
 * the jump is without needing a single word.
 */
function Motif({ palette, size }: MotifProps) {
  const unit = size / 100
  // Drawn top-down, so the array runs from rung 5 to rung 1.
  const rungs = [5, 4, 3, 2, 1]
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'center',
        gap: unit * 5,
      }}
    >
      {rungs.map((n) => {
        const accented = n === 4
        return (
          <div
            key={n}
            style={{
              display: 'flex',
              // Each step sits further right than the one below it, so the
              // stack reads as a climb rather than a list.
              marginLeft: unit * (n - 1) * 8,
              width: unit * 52,
              height: unit * 12,
              border: `${Math.max(2, unit * (accented ? 2 : 1))}px solid ${
                accented ? palette.accent : palette.muted40
              }`,
            }}
          />
        )
      })}
    </div>
  )
}

export const maturityLadder: FigureDefinition = {
  id: 'maturity-ladder',
  alt: 'A five-rung ladder from prompt library at the bottom to organisational agents at the top. Rung two, a skills and agents repository, is marked "you are here"; rung four, deployed capabilities, is highlighted as the jump that matters.',
  caption: 'The maturity ladder, and the rung most teams are standing on.',
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
}
