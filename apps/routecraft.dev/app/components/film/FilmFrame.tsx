import type { CSSProperties, ReactNode } from 'react'

import {
  ASKS_YOU,
  BECOME_CAPABILITIES,
  BECOME_LOCAL,
  BOARD,
  BOARD_EXIT,
  type BoardCard,
  CAPTIONS,
  CARD_H,
  CREDENTIALS,
  CROSSING,
  clamp01,
  DOOR_AT,
  DOORS,
  END_CARD,
  ENTRY_ARROWS,
  FILM_HEIGHT,
  FILM_WIDTH,
  HARNESS_BOX,
  HARNESS_DRAW,
  LOCAL_PANEL,
  mix,
  mixRect,
  PROMOTE,
  RECORD_LINES,
  type Rect,
  ramp,
  REMOTE,
  SCENE_OUT,
  SECOND_LOCAL,
  SETTLE,
  SUBJECT,
  SYSTEM_TILE_H,
  SYSTEM_TILE_X,
  SYSTEM_TILE_Y,
  SYSTEMS,
  SYSTEMS_BAND,
  span,
  systemCentre,
  TEAM_BLOCK_AT,
  TEAM_BLOCKS,
  TEAM_IN,
  TEAM_PANEL,
  TO_PLATFORM,
  TOOL_AT,
  TOOL_RECTS,
  TOOLS,
  TOP_BAND,
  TOP_BAND_IN,
  TRIAGE_STEPS,
  TRIGGER_AT,
  TRIGGERS,
  ZOOM_CARD,
  ZOOM_MOVE,
  blockRect,
} from './timeline'

/**
 * One frame of the platform film, as a pure function of time: the same `t`
 * always draws the same picture, which is what lets the player run it live and
 * the render script record it frame by frame.
 *
 * Every colour and face comes from the site's tokens through CSS variables, so
 * the film re-tones with the theme; the fallbacks are the light values, for
 * the render harness. Styles are inline because every value moves.
 */
export function FilmFrame({ t }: { t: number }) {
  const scene = 1 - ramp(t, SCENE_OUT.from, SCENE_OUT.duration)
  return (
    <div
      style={{
        position: 'relative',
        width: FILM_WIDTH,
        height: FILM_HEIGHT,
        overflow: 'hidden',
        background: PAPER,
        color: INK_SOLID,
        fontFamily: SANS,
      }}
    >
      <div style={{ position: 'absolute', inset: 0, opacity: scene }}>
        <SystemsBand t={t} />
        <BoardWires t={t} />
        {BOARD.map((card, i) =>
          i === SUBJECT ? null : <BoardTile key={i} card={card} t={t} i={i} />,
        )}
        <TopBand t={t} />
        <SecondLocal t={t} />
        <HarnessBox t={t} />
        <TeamPanel t={t} />
        <Subject t={t} />
        {TOOLS.map((name, i) => (
          <Tool key={name} name={name} i={i} t={t} />
        ))}
        <Crossing t={t} />
        <Arrows t={t} />
      </div>
      <Captions t={t} />
      <EndCard t={t} />
    </div>
  )
}

const PAPER = 'var(--color-paper, #f5f1e8)'
const PAPER_DEEP = 'var(--color-paper-deep, #ebe5da)'
const INK_SOLID = 'var(--color-ink, #22232c)'
const COBALT = 'var(--color-cobalt-500, #1247ff)'
const EDITORIAL = 'var(--font-fraunces, Georgia, serif)'
const SANS = 'var(--font-ibm-plex-sans, system-ui, sans-serif)'
const MONO = 'var(--font-jetbrains-mono, ui-monospace, monospace)'
const ink = (percent: number) =>
  `color-mix(in srgb, ${INK_SOLID} ${percent}%, transparent)`
const paper = (percent: number) =>
  `color-mix(in srgb, ${PAPER} ${percent}%, transparent)`
const DISPLAY = '"opsz" 144, "SOFT" 30'
const DISPLAY_ITALIC = '"opsz" 144, "SOFT" 100'

const at = (r: Rect): CSSProperties => ({
  position: 'absolute',
  left: r.x,
  top: r.y,
  width: r.w,
  height: r.h,
})

/** Labels on blocks and wires fade once the drawing settles. */
const labels = (t: number) => 1 - ramp(t, SETTLE.from, SETTLE.duration)

function Accent({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        color: COBALT,
        fontStyle: 'italic',
        fontVariationSettings: DISPLAY_ITALIC,
      }}
    >
      {children}
    </span>
  )
}

function Captions({ t }: { t: number }) {
  return CAPTIONS.map((caption, ci) => {
    const shown = span(t, caption.from, caption.to, 0.5)
    if (shown <= 0) return null
    const box: CSSProperties = caption.centred
      ? {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 200px',
          fontSize: 96,
          lineHeight: 1.04,
          textAlign: 'center',
        }
      : {
          position: 'absolute',
          left: 120,
          top: 72,
          width: 1560,
          fontSize: 58,
          lineHeight: 1.12,
        }
    return (
      <p
        key={ci}
        style={{
          ...box,
          margin: 0,
          opacity: shown,
          fontFamily: EDITORIAL,
          fontVariationSettings: DISPLAY,
          letterSpacing: '-0.02em',
        }}
      >
        <span>
          {caption.parts.map((part, pi) => {
            const p = ramp(t, part.at, 0.55)
            return (
              <span
                key={pi}
                style={{
                  opacity: p,
                  display: 'inline',
                  position: 'relative',
                  top: (1 - p) * 10,
                }}
              >
                {part.text}
                {part.accent && <Accent>{part.accent}</Accent>}
                {part.after}
              </span>
            )
          })}
        </span>
      </p>
    )
  })
}

function SystemsBand({ t }: { t: number }) {
  const shown = ramp(t, 4.9, 0.9) * (1 - 0.6 * span(t, 20.6, 38.9, 0.9))
  if (shown <= 0) return null
  return (
    <div
      style={{ ...at(SYSTEMS_BAND), background: PAPER_DEEP, opacity: shown }}
    >
      <PanelTitle
        name="Your systems"
        sub="as they are, where they are"
        x={30}
        y={26}
      />
      {SYSTEMS.map((system, i) => (
        <span
          key={system.label}
          style={{
            ...at({
              x: SYSTEM_TILE_X[i] - SYSTEMS_BAND.x,
              y: SYSTEM_TILE_Y - SYSTEMS_BAND.y,
              w: system.w,
              h: SYSTEM_TILE_H,
            }),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            border: `1px solid ${ink(22)}`,
            background: PAPER,
            fontFamily: MONO,
            fontSize: 16,
            whiteSpace: 'nowrap',
          }}
        >
          <Cylinder />
          {system.label}
        </span>
      ))}
    </div>
  )
}

function Cylinder() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      style={{ opacity: 0.55 }}
    >
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  )
}

function PanelTitle({
  name,
  sub,
  x,
  y,
  onPlate = false,
}: {
  name: string
  sub: string
  x: number
  y: number
  onPlate?: boolean
}) {
  return (
    <div style={{ position: 'absolute', left: x, top: y }}>
      <div
        style={{
          fontFamily: EDITORIAL,
          fontVariationSettings: DISPLAY,
          fontSize: 36,
          lineHeight: 1,
          letterSpacing: '-0.015em',
          color: onPlate ? PAPER : INK_SOLID,
        }}
      >
        {name}
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 17,
          color: onPlate ? paper(70) : ink(65),
        }}
      >
        {sub}
      </div>
    </div>
  )
}

/** How far a board card has left the stage. */
const boardExit = (t: number, i: number) =>
  ramp(t, BOARD_EXIT.from + (i % 5) * 0.08, BOARD_EXIT.duration)

function BoardWires({ t }: { t: number }) {
  if (t < BOARD[0].at || t > BOARD_EXIT.from + BOARD_EXIT.duration + 0.5)
    return null
  return (
    <svg
      width={FILM_WIDTH}
      height={FILM_HEIGHT}
      style={{ position: 'absolute', inset: 0 }}
      fill="none"
    >
      {BOARD.map((card, i) => {
        if (!card.to) return null
        const drawn = ramp(t, card.at + 0.25, 0.9)
        if (drawn <= 0) return null
        const sx = card.x + card.w / 2
        const sy = card.y + CARD_H
        const ex = systemCentre(card.to)
        const ey = SYSTEM_TILE_Y
        return (
          <path
            key={i}
            d={`M${sx} ${sy} C${sx} ${sy + 90} ${ex} ${ey - 110} ${ex} ${ey}`}
            pathLength={1}
            stroke={ink(32)}
            strokeWidth={1.5}
            strokeDasharray="1 1"
            strokeDashoffset={1 - drawn}
            opacity={1 - boardExit(t, i)}
          />
        )
      })}
    </svg>
  )
}

function CardFace({ card }: { card: BoardCard }) {
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontFamily: MONO,
          fontSize: 17,
          whiteSpace: 'nowrap',
        }}
      >
        <span
          style={{
            fontSize: 11,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            border: `1px solid ${ink(30)}`,
            padding: '2px 6px',
            color: ink(70),
          }}
        >
          {card.kind}
        </span>
        {card.name}
      </div>
      <div style={{ marginTop: 12, fontSize: 17, color: ink(75) }}>
        {card.line}
      </div>
      <div
        style={{
          marginTop: 6,
          fontFamily: EDITORIAL,
          fontStyle: 'italic',
          fontVariationSettings: DISPLAY_ITALIC,
          fontSize: 18,
          color: ink(55),
        }}
      >
        {card.note}
      </div>
    </>
  )
}

const cardBox: CSSProperties = {
  background: PAPER,
  border: `1px solid ${ink(20)}`,
  boxShadow: 'none',
  padding: '16px 18px',
  boxSizing: 'border-box',
  overflow: 'hidden',
}

function BoardTile({ card, t, i }: { card: BoardCard; t: number; i: number }) {
  const shown = ramp(t, card.at, 0.45)
  const gone = boardExit(t, i)
  const opacity = shown * (1 - gone)
  if (opacity <= 0) return null
  return (
    <div
      style={{
        ...at({ x: card.x, y: card.y, w: card.w, h: CARD_H }),
        ...cardBox,
        opacity,
        transform: `translateY(${(1 - shown) * 16 - gone * 24}px) rotate(${card.tilt}deg) scale(${0.96 + 0.04 * shown})`,
      }}
    >
      <CardFace card={card} />
    </div>
  )
}

/** triage.md: a card on the board, then the instruction up close, then a skill in the harness. */
function Subject({ t }: { t: number }) {
  const card = BOARD[SUBJECT]
  const shown = ramp(t, card.at, 0.45)
  if (shown <= 0) return null
  const zoom = ramp(t, ZOOM_MOVE.from, ZOOM_MOVE.duration)
  const dock = ramp(t, TO_PLATFORM.from, TO_PLATFORM.duration)
  const board = { x: card.x, y: card.y, w: card.w, h: CARD_H }
  const rect = mixRect(
    mixRect(board, ZOOM_CARD, zoom),
    blockRect(LOCAL_PANEL, 0),
    dock,
  )
  const boardFace = 1 - clamp01(zoom * 2.5)
  const zoomFace = clamp01((zoom - 0.6) / 0.4) * (1 - clamp01(dock * 4))
  const blockFace = clamp01((dock - 0.3) / 0.4) * labels(t)
  const skill = ramp(t, BECOME_LOCAL.from, BECOME_LOCAL.duration)
  return (
    <div
      style={{
        ...at(rect),
        ...cardBox,
        padding: 0,
        background: dock > 0.5 ? PAPER_DEEP : PAPER,
        border: `1px solid ${ink(dock > 0.5 ? 18 : 24)}`,
        opacity: shown,
        transform: `translateY(${(1 - shown) * 16}px) rotate(${card.tilt * (1 - zoom)}deg)`,
      }}
    >
      {boardFace > 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            padding: '16px 18px',
            opacity: boardFace,
          }}
        >
          <CardFace card={card} />
        </div>
      )}
      {zoomFace > 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            padding: '22px 28px',
            opacity: zoomFace,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontFamily: MONO,
              fontSize: 18,
              color: ink(60),
            }}
          >
            <span>triage.md</span>
            <span
              style={{
                color: COBALT,
                opacity: skill,
                letterSpacing: '0.14em',
                fontSize: 14,
                textTransform: 'uppercase',
              }}
            >
              skill
            </span>
          </div>
          <div
            style={{
              marginTop: 18,
              fontFamily: EDITORIAL,
              fontVariationSettings: DISPLAY,
              fontSize: 36,
              lineHeight: 1,
            }}
          >
            Triage an incident
          </div>
          <ol
            style={{
              margin: '18px 0 0',
              padding: '0 0 0 26px',
              fontSize: 21,
              lineHeight: 1.5,
              color: ink(78),
            }}
          >
            {TRIAGE_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}
      {blockFace > 0 && (
        <BlockLabel eyebrow="skill" name="triage.md" opacity={blockFace} />
      )}
    </div>
  )
}

function BlockLabel({
  eyebrow,
  name,
  opacity,
  onPlate = false,
  accent = false,
}: {
  eyebrow: string
  name: string
  opacity: number
  onPlate?: boolean
  accent?: boolean
}) {
  return (
    <div
      style={{ position: 'absolute', inset: 0, padding: '12px 14px', opacity }}
    >
      <div
        style={{
          fontFamily: MONO,
          fontSize: 11,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: accent ? COBALT : onPlate ? paper(60) : ink(55),
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          marginTop: 8,
          fontFamily: MONO,
          fontSize: 17,
          whiteSpace: 'nowrap',
          color: onPlate ? PAPER : INK_SOLID,
        }}
      >
        {name}
      </div>
    </div>
  )
}

/** A tool the instruction needs, which becomes a capability, then a block in the local harness. */
function Tool({ name, i, t }: { name: string; i: number; t: number }) {
  const shown = ramp(t, TOOL_AT[i], 0.5)
  if (shown <= 0) return null
  const capability = ramp(
    t,
    BECOME_CAPABILITIES.from + i * BECOME_CAPABILITIES.stagger,
    BECOME_CAPABILITIES.duration,
  )
  const dock = ramp(t, TO_PLATFORM.from, TO_PLATFORM.duration)
  const rect = mixRect(TOOL_RECTS[i], blockRect(LOCAL_PANEL, i + 1), dock)
  const border = `color-mix(in srgb, ${COBALT} ${Math.round(capability * (1 - dock) * 100)}%, ${ink(26)})`
  return (
    <div
      style={{
        ...at(rect),
        boxSizing: 'border-box',
        background: dock > 0.5 ? PAPER_DEEP : PAPER,
        border: `${mix(1.5, 1, dock)}px solid ${border}`,
        opacity: shown,
        transform: `translateY(${(1 - shown) * 18}px)`,
      }}
    >
      <BlockLabel
        eyebrow="tool"
        name={name}
        opacity={(1 - capability) * labels(t)}
      />
      <BlockLabel
        eyebrow="capability"
        name={name}
        opacity={capability * labels(t)}
        accent={dock < 0.5}
      />
    </div>
  )
}

function HarnessBox({ t }: { t: number }) {
  const drawn = ramp(t, HARNESS_DRAW.from, HARNESS_DRAW.duration)
  if (drawn <= 0) return null
  const dock = ramp(t, TO_PLATFORM.from, TO_PLATFORM.duration)
  const rect = mixRect(HARNESS_BOX, LOCAL_PANEL, dock)
  const local = ramp(t, BECOME_LOCAL.from, BECOME_LOCAL.duration)
  return (
    <>
      <div style={{ ...at(rect), background: PAPER_DEEP, opacity: dock }} />
      <svg
        width={FILM_WIDTH}
        height={FILM_HEIGHT}
        style={{ position: 'absolute', inset: 0 }}
        fill="none"
      >
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.w}
          height={rect.h}
          pathLength={1}
          stroke={ink(mix(45, 0, dock))}
          strokeWidth={1.5}
          strokeDasharray="1 1"
          strokeDashoffset={1 - drawn}
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          left: rect.x + 22,
          top: rect.y + 18,
          fontFamily: MONO,
          fontSize: 14,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: ink(60),
          opacity: drawn * (1 - local),
        }}
      >
        harness
      </div>
      <div style={{ ...at(rect), opacity: local }}>
        <PanelTitle
          name="Local harness"
          sub={
            dock > 0.5 ? 'on your laptop, on your own access' : 'on your laptop'
          }
          x={30}
          y={28}
        />
      </div>
    </>
  )
}

function SecondLocal({ t }: { t: number }) {
  const shown = ramp(t, SECOND_LOCAL.from, SECOND_LOCAL.duration)
  if (shown <= 0) return null
  const r = LOCAL_PANEL
  return (
    <>
      <div
        style={{
          ...at({ x: r.x - 16, y: r.y - 16, w: r.w, h: r.h }),
          border: `1.5px dashed ${ink(35)}`,
          opacity: shown,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: r.x - 16,
          top: r.y - 44,
          fontFamily: MONO,
          fontSize: 13,
          color: ink(60),
          opacity: shown * labels(t),
        }}
      >
        one per person
      </div>
    </>
  )
}

function TeamPanel({ t }: { t: number }) {
  const shown = ramp(t, TEAM_IN.from, TEAM_IN.duration)
  if (shown <= 0) return null
  return (
    <div
      style={{
        ...at(TEAM_PANEL),
        background: INK_SOLID,
        opacity: shown,
        transform: `translateX(${(1 - shown) * 40}px)`,
      }}
    >
      <PanelTitle
        name="Team harness"
        sub="always on, on service credentials, every call on record"
        x={30}
        y={28}
        onPlate
      />
      {RECORD_LINES.map((line) => {
        const typed = clamp01((t - line.at) / 0.5)
        if (typed <= 0) return null
        return (
          <div
            key={line.text}
            style={{
              position: 'absolute',
              left: 30,
              top: 120 + RECORD_LINES.indexOf(line) * 26,
              fontFamily: MONO,
              fontSize: 15,
              whiteSpace: 'pre',
              color: paper(78),
              opacity: labels(t),
            }}
          >
            {line.text.slice(0, Math.round(line.text.length * typed))}
          </div>
        )
      })}
      {TEAM_BLOCKS.map((name, i) => {
        const block = ramp(t, TEAM_BLOCK_AT[i], 0.45)
        if (block <= 0) return null
        const r = blockRect(TEAM_PANEL, i)
        return (
          <div
            key={name}
            style={{
              ...at({
                x: r.x - TEAM_PANEL.x,
                y: r.y - TEAM_PANEL.y,
                w: r.w,
                h: r.h,
              }),
              boxSizing: 'border-box',
              background: paper(12),
              border: `1px solid ${paper(28)}`,
              opacity: block,
            }}
          >
            <BlockLabel
              eyebrow="capability"
              name={name}
              opacity={labels(t)}
              onPlate
            />
          </div>
        )
      })}
    </div>
  )
}

/** The promoted capability travelling from the laptop to the team harness. */
function Crossing({ t }: { t: number }) {
  const p = ramp(t, CROSSING.from, CROSSING.duration)
  if (p <= 0 || t > CROSSING.from + CROSSING.duration + 0.3) return null
  const from = blockRect(LOCAL_PANEL, CROSSING.capability + 1)
  const to = blockRect(TEAM_PANEL, 0)
  const rect = mixRect(from, to, p)
  const lift = Math.sin(p * Math.PI) * 60
  return (
    <div
      style={{
        ...at({ ...rect, y: rect.y - lift }),
        boxSizing: 'border-box',
        background: PAPER,
        border: `1.5px solid ${COBALT}`,
        opacity: 1 - ramp(t, CROSSING.from + CROSSING.duration, 0.3),
      }}
    >
      <BlockLabel
        eyebrow="capability"
        name={TOOLS[CROSSING.capability]}
        opacity={1}
        accent
      />
    </div>
  )
}

function TopBand({ t }: { t: number }) {
  const shown = ramp(t, TOP_BAND_IN.from, TOP_BAND_IN.duration)
  if (shown <= 0) return null
  const blocks = [
    ...DOORS.map((name, i) => ({
      name,
      at: DOOR_AT(i),
      x: 640 + i * 124,
      door: true,
    })),
    ...TRIGGERS.map((name, i) => ({
      name,
      at: TRIGGER_AT(i),
      x: 1162 + i * 124,
      door: false,
    })),
  ]
  return (
    <div style={{ ...at(TOP_BAND), background: PAPER_DEEP, opacity: shown }}>
      <PanelTitle
        name="Every way in"
        sub="when someone asks, and when nobody does"
        x={30}
        y={22}
      />
      {blocks.map((b) => {
        const p = ramp(t, b.at, 0.4)
        if (p <= 0) return null
        return (
          <span
            key={b.name}
            style={{
              ...at({ x: b.x - TOP_BAND.x, y: 27, w: 110, h: 56 }),
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: PAPER,
              border: `1.5px ${b.door ? 'solid' : 'dashed'} ${ink(b.door ? 30 : 38)}`,
              fontFamily: MONO,
              fontSize: 16,
              opacity: p,
              transform: `translateY(${(1 - p) * -10}px)`,
            }}
          >
            <span style={{ opacity: labels(t) }}>{b.name}</span>
          </span>
        )
      })}
    </div>
  )
}

function Arrow({
  x1,
  y1,
  x2,
  y2,
  drawn,
  colour,
  dashed = false,
}: {
  x1: number
  y1: number
  x2: number
  y2: number
  drawn: number
  colour: string
  dashed?: boolean
}) {
  if (drawn <= 0) return null
  const x = mix(x1, x2, drawn)
  const y = mix(y1, y2, drawn)
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const head = (a: number) =>
    `${x - 11 * Math.cos(angle + a)},${y - 11 * Math.sin(angle + a)}`
  return (
    <g stroke={colour} strokeWidth={1.6} fill="none">
      <line
        x1={x1}
        y1={y1}
        x2={x}
        y2={y}
        strokeDasharray={dashed ? '6 6' : undefined}
      />
      <polyline points={`${head(0.5)} ${x},${y} ${head(-0.5)}`} />
    </g>
  )
}

function ArrowLabel({
  x,
  y,
  children,
  opacity,
  colour,
}: {
  x: number
  y: number
  children: ReactNode
  opacity: number
  colour?: string
}) {
  if (opacity <= 0) return null
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        fontFamily: MONO,
        fontSize: 14,
        whiteSpace: 'nowrap',
        color: colour ?? ink(62),
        opacity,
      }}
    >
      {children}
    </div>
  )
}

function Arrows({ t }: { t: number }) {
  const promote = ramp(t, PROMOTE.from, PROMOTE.duration)
  const remote = ramp(t, REMOTE.from, REMOTE.duration)
  const entry = ramp(t, ENTRY_ARROWS.from, ENTRY_ARROWS.duration)
  const asks = ramp(t, ASKS_YOU.from, ASKS_YOU.duration)
  const credentials = ramp(t, CREDENTIALS.from, CREDENTIALS.duration)
  const l = labels(t)
  const localX = LOCAL_PANEL.x + 390
  const teamX = TEAM_PANEL.x + 390
  const bottom = LOCAL_PANEL.y + LOCAL_PANEL.h
  return (
    <>
      <svg
        width={FILM_WIDTH}
        height={FILM_HEIGHT}
        style={{ position: 'absolute', inset: 0 }}
      >
        <Arrow
          x1={904}
          y1={540}
          x2={1014}
          y2={540}
          drawn={promote}
          colour={ink(70)}
        />
        <Arrow
          x1={1014}
          y1={620}
          x2={906}
          y2={620}
          drawn={remote}
          colour={ink(60)}
          dashed
        />
        <Arrow
          x1={localX}
          y1={TOP_BAND.y + TOP_BAND.h + 4}
          x2={localX}
          y2={LOCAL_PANEL.y - 22}
          drawn={entry}
          colour={ink(60)}
        />
        <Arrow
          x1={teamX}
          y1={TOP_BAND.y + TOP_BAND.h + 4}
          x2={teamX}
          y2={TEAM_PANEL.y - 6}
          drawn={entry}
          colour={ink(60)}
        />
        <Arrow
          x1={TEAM_PANEL.x + 740}
          y1={TEAM_PANEL.y - 6}
          x2={TEAM_PANEL.x + 740}
          y2={TOP_BAND.y + TOP_BAND.h + 4}
          drawn={asks}
          colour={COBALT}
        />
        <Arrow
          x1={localX}
          y1={bottom + 4}
          x2={localX}
          y2={SYSTEMS_BAND.y - 6}
          drawn={credentials}
          colour={ink(55)}
          dashed
        />
        <Arrow
          x1={teamX}
          y1={bottom + 4}
          x2={teamX}
          y2={SYSTEMS_BAND.y - 6}
          drawn={credentials}
          colour={COBALT}
        />
      </svg>
      <ArrowLabel x={906} y={508} opacity={promote * l}>
        promote
      </ArrowLabel>
      <ArrowLabel x={920} y={632} opacity={remote * l}>
        remote
      </ArrowLabel>
      <ArrowLabel
        x={teamX + 16}
        y={TOP_BAND.y + TOP_BAND.h + 22}
        opacity={asks * l}
        colour={COBALT}
      >
        asks you when it needs a decision
      </ArrowLabel>
      <ArrowLabel x={localX + 14} y={bottom + 34} opacity={credentials * l}>
        personal credentials
      </ArrowLabel>
      <ArrowLabel
        x={teamX + 14}
        y={bottom + 34}
        opacity={credentials * l}
        colour={COBALT}
      >
        service credentials
      </ArrowLabel>
    </>
  )
}

function EndCard({ t }: { t: number }) {
  const shown = ramp(t, END_CARD.from, 1)
  if (shown <= 0) return null
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: shown,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 34 }}>
        <svg
          viewBox="0 0 200 200"
          width={132}
          height={132}
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M125 175H75V125L125 175ZM175 175H125V125L175 175ZM125 25C152.614 25 175 47.3858 175 75C175 102.614 152.614 125 125 125V75H75L125 125H75L25 75V25H125Z" />
        </svg>
        <span
          style={{
            fontFamily: EDITORIAL,
            fontVariationSettings: DISPLAY,
            fontSize: 132,
            letterSpacing: '-0.03em',
            lineHeight: 1,
          }}
        >
          Routecraft
        </span>
      </div>
      <p
        style={{
          margin: '46px 0 0',
          fontFamily: EDITORIAL,
          fontVariationSettings: DISPLAY,
          fontSize: 54,
          letterSpacing: '-0.02em',
          opacity: ramp(t, END_CARD.from + 0.6, 0.8),
        }}
      >
        Give AI access, <Accent>not control</Accent>.
      </p>
      <p
        style={{
          margin: '40px 0 0',
          fontFamily: MONO,
          fontSize: 20,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: ink(60),
          opacity: ramp(t, END_CARD.from + 1.2, 0.8),
        }}
      >
        routecraft.dev · open source
      </p>
    </div>
  )
}
