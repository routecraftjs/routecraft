import type { CSSProperties } from 'react'

import {
  Arrow,
  Block,
  Chip,
  Eyebrow,
  FigureCanvas,
  MonoNote,
  Plate,
} from '@/components/figures/primitives'
import type {
  FigureDrawing,
  FigureProps,
  MotifProps,
} from '@/components/figures/types'

const WIDTH = 1600
const HEIGHT = 900

const CODE: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.95rem',
  letterSpacing: '0.02em',
  whiteSpace: 'pre',
  textAlign: 'left',
}

/** The tool as the post writes it, minus the schema, so it reads at a glance. */
const ROUTE = [
  'craft()',
  "  .id('notes_list')",
  "  .description('List notes…')",
  '  .input({ body: ListNotesInput })',
  '  .from(mcp())',
  '  .transform((input) => store.list(input.query))',
]

const DONE_FOR_YOU = [
  'MCP framing',
  'input validation',
  'typed transform',
  'structured logging',
  'graceful shutdown',
]

const CLIENTS = ['Claude Desktop', 'Cursor', 'MCP Inspector']

function Figure({ palette }: FigureProps) {
  return (
    <FigureCanvas palette={palette} width={WIDTH} height={HEIGHT}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '70px 72px 56px',
        }}
      >
        <Eyebrow palette={palette} accent>
          A TypeScript function becomes an MCP tool
        </Eyebrow>

        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 28,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <Chip palette={palette} style={{ fontSize: '1rem' }}>
              bunx create-routecraft
            </Chip>
            <Arrow palette={palette} size="1.5rem">
              ↓
            </Arrow>
            <Block
              palette={palette}
              style={{
                width: 570,
                padding: '26px 30px',
                alignItems: 'flex-start',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              <span style={{ fontSize: '1.1rem', letterSpacing: '0.16em' }}>
                CAPABILITY
              </span>
              <span style={{ ...CODE, color: palette.ink }}>
                {ROUTE.join('\n')}
              </span>
            </Block>
            <MonoNote palette={palette} size="0.9rem">
              the twenty lines that are yours
            </MonoNote>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Arrow palette={palette} accent size="1.6rem" />
            <MonoNote palette={palette} accent size="0.9rem">
              craft run
            </MonoNote>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              width: 330,
            }}
          >
            <Plate
              palette={palette}
              style={{ padding: '24px 20px', fontSize: '1.25rem' }}
            >
              MCP SERVER
            </Plate>
            {DONE_FOR_YOU.map((label) => (
              <div
                key={label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  paddingLeft: 8,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    backgroundColor: palette.accent,
                    display: 'block',
                    flexShrink: 0,
                  }}
                />
                <MonoNote palette={palette} size="0.95rem">
                  {label}
                </MonoNote>
              </div>
            ))}
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Arrow palette={palette} size="1.6rem" />
            <MonoNote palette={palette} size="0.9rem">
              stdio
            </MonoNote>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {CLIENTS.map((client) => (
              <Chip key={client} palette={palette} style={{ fontSize: '1rem' }}>
                {client}
              </Chip>
            ))}
          </div>
        </div>

        <p
          style={{
            margin: 0,
            textAlign: 'center',
            fontFamily: 'var(--font-editorial)',
            fontStyle: 'italic',
            fontSize: '1.8rem',
            lineHeight: 1.45,
            color: palette.ink60,
            borderTop: `1px solid ${palette.ink15}`,
            paddingTop: 32,
            fontVariationSettings: '"opsz" 96, "SOFT" 60',
          }}
        >
          The boring parts are done, so{' '}
          <span style={{ color: palette.accent }}>
            you write only the part that is yours.
          </span>
        </p>
      </div>
    </FigureCanvas>
  )
}

/**
 * Motif: one accented block feeding a filled plate, which fans out to three
 * clients. The block is the function; everything after it is Routecraft.
 */
function Motif({ palette, size }: MotifProps) {
  const unit = size / 100
  const stroke = Math.max(2, unit * 1.2)
  const rail = (
    <div
      style={{
        width: unit * 8,
        height: Math.max(1, unit * 0.9),
        backgroundColor: palette.muted55,
      }}
    />
  )
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
          width: unit * 26,
          height: unit * 30,
          border: `${stroke * 1.6}px solid ${palette.accent}`,
        }}
      />
      {rail}
      <div
        style={{
          width: unit * 16,
          height: unit * 40,
          backgroundColor: palette.fg,
        }}
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: unit * 6,
        }}
      >
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
            {rail}
            <div
              style={{
                width: unit * 16,
                height: unit * 9,
                border: `${stroke}px solid ${palette.muted55}`,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

export const functionToMcpTool: FigureDrawing = {
  id: 'function-to-mcp-tool',
  width: WIDTH,
  height: HEIGHT,
  Figure,
  Motif,
}
