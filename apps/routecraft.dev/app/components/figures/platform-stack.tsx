import type { CSSProperties } from 'react'

import {
  BlockRow,
  Conclusion,
  FigureCanvas,
  LayerName,
  LayerSub,
  MONO,
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

type PlatformStackLayer =
  'every-way-in' | 'agents' | 'skills' | 'capabilities' | 'adapters' | 'systems'

interface Layer {
  id: PlatformStackLayer
  name: string
  sub: string
  /** Unlabelled blocks: how much of the layer there is, not what it is. */
  blocks: number
  /** Index of the block that stands apart from the ones after it. */
  gapAfter?: number
  /** The bottom layer draws stores rather than plain blocks. */
  cylinders?: boolean
}

const LAYERS: Layer[] = [
  {
    id: 'every-way-in',
    name: 'Every way in',
    sub: 'editors, MCP clients, the CLI, HTTP, and the triggers that wake it',
    blocks: 9,
    gapAfter: 3,
  },
  {
    id: 'agents',
    name: 'Agents',
    sub: 'the agents you onboard, on any model',
    blocks: 5,
  },
  {
    id: 'skills',
    name: 'Skills',
    sub: 'what an agent knows how to do, shared as packages',
    blocks: 6,
  },
  {
    id: 'capabilities',
    name: 'Capabilities',
    sub: 'what an agent is allowed to do, built once',
    blocks: 12,
  },
  {
    id: 'adapters',
    name: 'Adapters',
    sub: 'the plumbing: APIs, mail, files, browsers, shells',
    blocks: 8,
  },
  {
    id: 'systems',
    name: 'Your systems',
    sub: 'as they are, where they are',
    blocks: 8,
    cylinders: true,
  },
]

function Band({ layer, palette }: { layer: Layer; palette: FigurePalette }) {
  return (
    <div
      style={{
        gridColumn: 2,
        height: 110,
        padding: '0 24px',
        background: palette.paperDeepSolid,
        display: 'flex',
        alignItems: 'center',
        gap: 24,
      }}
    >
      <div
        style={{
          width: 340,
          flex: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <LayerName>{layer.name}</LayerName>
        <LayerSub colour={palette.ink60}>{layer.sub}</LayerSub>
      </div>
      <BlockRow
        count={layer.blocks}
        fill={palette.ink25}
        gapAfter={layer.gapAfter}
      >
        {layer.cylinders && <StoreMark colour={palette.paper} />}
      </BlockRow>
    </div>
  )
}

/** Mono label read along a rail, bottom to top on the left and top to bottom on the right. */
function RailLabel({
  palette,
  flip = false,
  style,
  lines,
}: {
  palette: FigurePalette
  flip?: boolean
  style?: CSSProperties
  lines: [string, string]
}) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: 13,
        letterSpacing: '0.06em',
        color: palette.ink60,
        writingMode: 'vertical-rl',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        transform: flip ? 'rotate(180deg)' : undefined,
        ...style,
      }}
    >
      {lines[0]}
      <br />
      {lines[1]}
    </span>
  )
}

/** The platform as six bands, from every way in down to your systems. */
function PlatformStackFigure({ palette }: FigureProps) {
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
        <div
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: '78px 1300px 78px',
            rowGap: 10,
            alignContent: 'center',
          }}
        >
          <div
            style={{
              gridColumn: 1,
              gridRow: '1 / 7',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingRight: 14,
            }}
          >
            <RailLabel
              palette={palette}
              flip
              style={{ marginRight: 22 }}
              lines={[
                'runs on your laptop as a local harness,',
                'or always on as the team harness',
              ]}
            />
          </div>
          {/* The bracket spans the five layers Routecraft runs; the systems layer is yours. */}
          <div
            style={{
              gridColumn: 1,
              gridRow: '1 / 6',
              justifySelf: 'end',
              width: 12,
              marginRight: 14,
              border: `1px solid ${palette.ink40}`,
              borderRight: 'none',
            }}
          />

          {LAYERS.map((layer) => (
            <Band key={layer.id} layer={layer} palette={palette} />
          ))}

          <div
            style={{
              gridColumn: 3,
              gridRow: '1 / 7',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-start',
              gap: 10,
              paddingLeft: 14,
            }}
          >
            <span
              style={{
                alignSelf: 'stretch',
                width: 3,
                background: palette.accent,
              }}
            />
            <RailLabel
              palette={palette}
              lines={[
                'who asked, which door, which capability,',
                'which system: on record',
              ]}
            />
          </div>
        </div>

        <Conclusion
          palette={palette}
          accent="open at any depth."
          style={{ marginTop: 24 }}
        >
          One runtime, six layers,
        </Conclusion>
      </div>
    </FigureCanvas>
  )
}

/**
 * Motif: six bands of differing length beside the accent strip that runs the
 * full height, so the record spanning every layer survives the reduction.
 */
function Motif({ palette, size }: MotifProps) {
  const unit = size / 100
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: unit * 6,
      }}
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: unit * 3.5 }}
      >
        {LAYERS.map((layer) => (
          <div
            key={layer.id}
            style={{
              width: unit * (24 + layer.blocks * 4),
              height: unit * 8,
              backgroundColor: palette.muted25,
            }}
          />
        ))}
      </div>
      <div
        style={{
          width: unit * 2,
          height: unit * 65.5,
          backgroundColor: palette.accent,
        }}
      />
    </div>
  )
}

export const platformStack: FigureDrawing = {
  id: 'platform-stack',
  width: WIDTH,
  height: HEIGHT,
  Figure: PlatformStackFigure,
  Motif,
}
