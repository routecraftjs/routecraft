import {
  AccentItalic,
  Body,
  Chip,
  Eyebrow,
  FigureCanvas,
  Subhead,
} from '@/components/figures/primitives'
import type { FigurePalette } from '@/components/figures/palette'
import type {
  FigureDrawing,
  FigureProps,
  MotifProps,
} from '@/components/figures/types'

const WIDTH = 1600
const HEIGHT = 900

const PRIMITIVES = [
  {
    n: 1,
    title: 'Delegation',
    body: 'asks the right person · parks the work · resumes',
  },
  {
    n: 2,
    title: 'Shared memory',
    body: 'answered once · answered for everyone',
  },
  {
    n: 3,
    title: 'Capability gaps',
    body: 'files the request · never grants it',
  },
  { n: 4, title: 'Channels', body: 'email · chat · phone · one agent' },
]

const RULES = [
  'one capability · one policy · many consumers',
  'agents are one execution mode · not the platform',
  'capabilities grow from real demand',
]

function Primitive({
  primitive,
  palette,
}: {
  primitive: (typeof PRIMITIVES)[number]
  palette: FigurePalette
}) {
  return (
    <div
      style={{
        border: `2px solid ${palette.accent}`,
        padding: '20px 30px',
        display: 'flex',
        alignItems: 'center',
        gap: 24,
      }}
    >
      <AccentItalic palette={palette} size="2.3rem">
        {primitive.n}
      </AccentItalic>
      <div>
        <Subhead palette={palette} size="1.9rem">
          {primitive.title}
        </Subhead>
        <Body palette={palette} size="1.4rem">
          {primitive.body}
        </Body>
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
          padding: '64px 72px',
        }}
      >
        <Eyebrow palette={palette} accent>
          The team agent harness
        </Eyebrow>

        <div
          style={{
            marginTop: 26,
            flex: 1,
            border: `2px solid ${palette.ink35}`,
            padding: '30px 36px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '1.05rem',
              letterSpacing: '0.16em',
              color: palette.ink55,
            }}
          >
            HARNESS · FOUR PRIMITIVES
          </div>

          <div
            style={{
              flex: 1,
              marginTop: 24,
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) 250px minmax(0,1fr)',
              gridTemplateRows: '1fr 1fr',
              gap: 22,
            }}
          >
            <Primitive primitive={PRIMITIVES[0]} palette={palette} />

            {/* The model sits between the primitives, doing only judgement. */}
            <div
              style={{
                gridRow: '1 / 3',
                gridColumn: 2,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 14,
              }}
            >
              <Chip
                palette={palette}
                style={{ fontSize: '1.5rem', padding: '32px 40px' }}
              >
                model
              </Chip>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '1.1rem',
                  color: palette.ink55,
                }}
              >
                judgement only
              </span>
            </div>

            <Primitive primitive={PRIMITIVES[1]} palette={palette} />
            <Primitive primitive={PRIMITIVES[2]} palette={palette} />
            <Primitive primitive={PRIMITIVES[3]} palette={palette} />
          </div>
        </div>

        <div
          style={{
            marginTop: 22,
            fontFamily: 'var(--font-mono)',
            fontSize: '1rem',
            letterSpacing: '0.16em',
            color: palette.accent,
          }}
        >
          PLATFORM RULES
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 18 }}>
          {RULES.map((rule) => (
            <div
              key={rule}
              style={{
                flex: 1,
                border: `1px dashed ${palette.ink40}`,
                padding: '18px 12px',
                textAlign: 'center',
                fontFamily: 'var(--font-mono)',
                fontSize: '1.05rem',
                color: palette.ink60,
              }}
            >
              {rule}
            </div>
          ))}
        </div>
      </div>
    </FigureCanvas>
  )
}

/**
 * Motif: four accented primitives around a central model, inside the harness
 * boundary. The composition is the point, so no labels survive the reduction.
 */
function Motif({ palette, size }: MotifProps) {
  const unit = size / 100
  const stroke = Math.max(2, unit * 1.3)
  const cell = {
    width: unit * 26,
    height: unit * 17,
    border: `${stroke}px solid ${palette.accent}`,
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: unit * 4,
          padding: unit * 6,
          border: `${Math.max(1, unit * 0.9)}px solid ${palette.muted55}`,
        }}
      >
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: unit * 4 }}
        >
          <div style={cell} />
          <div style={cell} />
        </div>
        <div
          style={{
            width: unit * 18,
            height: unit * 18,
            backgroundColor: palette.fg,
          }}
        />
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: unit * 4 }}
        >
          <div style={cell} />
          <div style={cell} />
        </div>
      </div>
    </div>
  )
}

export const teamAgentHarness: FigureDrawing = {
  id: 'team-agent-harness',
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
}
