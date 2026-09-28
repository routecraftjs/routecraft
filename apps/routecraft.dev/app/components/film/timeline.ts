/**
 * The platform film as data: when every caption, card and block appears, in
 * seconds from the start. The drawing (`FilmFrame`), the player and the score
 * generator (`scripts/film/score.ts`) all read these numbers, so a change to
 * the timing moves the picture and the music together.
 *
 * The canvas is 1920 by 1080. Every position here is in canvas pixels.
 */

export const FILM_WIDTH = 1920
export const FILM_HEIGHT = 1080
export const FILM_DURATION = 61

/** A frame worth showing when the film is not playing: the settled platform. */
export const FILM_POSTER_TIME = 54

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** Cubic ease in and out. */
export const ease = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2

/** 0 before `start`, 1 after `start + duration`, eased in between. */
export const ramp = (t: number, start: number, duration: number) =>
  ease(clamp01((t - start) / duration))

/** Fades in at `from`, holds, and fades out so it is gone by `to`. */
export const span = (t: number, from: number, to: number, fade = 0.5) =>
  Math.min(ramp(t, from, fade), 1 - ramp(t, to - fade, fade))

export const mix = (a: number, b: number, p: number) => a + (b - a) * p

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const mixRect = (a: Rect, b: Rect, p: number): Rect => ({
  x: mix(a.x, b.x, p),
  y: mix(a.y, b.y, p),
  w: mix(a.w, b.w, p),
  h: mix(a.h, b.h, p),
})

/** One caption line. `accent` is the single phrase set in cobalt italic. */
export interface CaptionPart {
  at: number
  text: string
  accent?: string
  after?: string
}

export interface Caption {
  from: number
  to: number
  parts: CaptionPart[]
  /** The opening line sits large in the middle of the empty canvas. */
  centred?: boolean
}

export const CAPTIONS: Caption[] = [
  {
    from: 0.6,
    to: 3.3,
    centred: true,
    parts: [
      {
        at: 0.6,
        text: 'Your teams are building ',
        accent: 'useful',
        after: ' AI tools.',
      },
    ],
  },
  {
    from: 3.4,
    to: 12.2,
    parts: [
      { at: 3.4, text: 'But the work is ', accent: 'fragmented', after: '. ' },
      { at: 6.3, text: 'Scattered scripts. ' },
      { at: 7.6, text: 'Personal logins. ' },
      {
        at: 9,
        text: 'The next team builds the ',
        accent: 'same thing',
        after: ' again.',
      },
    ],
  },
  {
    from: 12.4,
    to: 20,
    parts: [
      {
        at: 12.4,
        text: '',
        accent: 'Routecraft',
        after: ' is an open source platform ',
      },
      {
        at: 15,
        text: 'for AI capabilities your teams can ',
        accent: 'run and reuse',
        after: '.',
      },
    ],
  },
  {
    from: 20.3,
    to: 27.3,
    parts: [
      {
        at: 20.3,
        text: 'Start with one: ',
        accent: 'find overdue invoices',
        after: '. ',
      },
      { at: 23, text: 'Build it in TypeScript. ' },
      { at: 24.7, text: 'Test it on your laptop.' },
    ],
  },
  {
    from: 27.5,
    to: 34.2,
    parts: [
      {
        at: 27.5,
        text: 'Deploy it on ',
        accent: 'your infrastructure',
        after: '. ',
      },
      { at: 29.8, text: 'Service credentials. ' },
      { at: 31.4, text: 'Access rules ', accent: 'you control', after: '.' },
    ],
  },
  {
    from: 34.4,
    to: 39.4,
    parts: [
      {
        at: 34.4,
        text: '',
        accent: 'Finance',
        after: ' calls it from an agent. ',
      },
      { at: 36.7, text: '', accent: 'Sales', after: ', from their editor.' },
    ],
  },
  {
    from: 39.6,
    to: 45.7,
    parts: [
      { at: 39.6, text: 'Run it on a ', accent: 'schedule', after: '. ' },
      { at: 41.4, text: 'Same capability. ' },
      { at: 42.8, text: 'No duplicated integration.' },
    ],
  },
  {
    from: 45.9,
    to: 50.7,
    parts: [
      { at: 45.9, text: 'Enable telemetry. ' },
      {
        at: 47.3,
        text: 'Record ',
        accent: 'who called it',
        after: ', and what happened.',
      },
    ],
  },
  {
    from: 50.9,
    to: 55,
    parts: [
      {
        at: 50.9,
        text: 'What one team ',
        accent: 'proves',
        after: ', every team can use.',
      },
    ],
  },
]

/** The closing card: logo, name and tagline. */
export const END_CARD = { from: 55.8, to: FILM_DURATION + 1 }

export const SYSTEMS = [
  { label: 'CRM', w: 96 },
  { label: 'ERP', w: 96 },
  { label: 'HR and payroll', w: 200 },
  { label: 'support desk', w: 180 },
  { label: 'knowledge base', w: 200 },
  { label: 'mail and calendar', w: 232 },
  { label: 'chat', w: 96 },
  { label: 'source control', w: 200 },
] as const

export type SystemLabel = (typeof SYSTEMS)[number]['label']

export const SYSTEMS_BAND: Rect = { x: 120, y: 850, w: 1680, h: 130 }
export const SYSTEM_TILE_Y = 885
export const SYSTEM_TILE_H = 60
const TILE_GAP = 12
const tilesWidth =
  SYSTEMS.reduce((sum, s) => sum + s.w, 0) + TILE_GAP * (SYSTEMS.length - 1)
const tilesStart = SYSTEMS_BAND.x + SYSTEMS_BAND.w - 28 - tilesWidth

/** Left edge of every system tile, in order. */
export const SYSTEM_TILE_X: number[] = SYSTEMS.reduce<number[]>(
  (xs, s, i) => [
    ...xs,
    i === 0 ? tilesStart : xs[i - 1] + SYSTEMS[i - 1].w + TILE_GAP,
  ],
  [],
)

export const systemCentre = (label: SystemLabel) => {
  const i = SYSTEMS.findIndex((s) => s.label === label)
  return SYSTEM_TILE_X[i] + SYSTEMS[i].w / 2
}

/** One team-built tool on the problem board. */
export interface BoardCard {
  kind: string
  name: string
  line: string
  note: string
  x: number
  y: number
  w: number
  tilt: number
  at: number
  to?: SystemLabel
  /** Calls a system another card already calls: the same thing, built again. */
  duplicate?: boolean
}

export const CARD_H = 118

export const BOARD: BoardCard[] = [
  {
    kind: 'py',
    name: 'sync_crm.py',
    line: 'shared drive › Finance › scripts',
    note: 'runs when someone remembers',
    x: 140,
    y: 280,
    w: 270,
    tilt: -2,
    at: 3.2,
    to: 'CRM',
    duplicate: true,
  },
  {
    kind: 'md',
    name: 'AGENTS.md',
    line: 'twelve steps, no tools',
    note: 'works on one laptop',
    x: 470,
    y: 250,
    w: 320,
    tilt: 1.5,
    at: 3.58,
    to: 'knowledge base',
  },
  {
    kind: 'js',
    name: 'get_token.js',
    line: 'copies the session cookie',
    note: 'expires daily, log in again',
    x: 850,
    y: 290,
    w: 280,
    tilt: -1,
    at: 3.96,
    to: 'support desk',
  },
  {
    kind: 'xlsm',
    name: 'month-end.xlsm',
    line: 'a macro that calls the ERP',
    note: 'one analyst’s laptop',
    x: 1190,
    y: 255,
    w: 280,
    tilt: 2.5,
    at: 4.34,
    to: 'ERP',
  },
  {
    kind: 'dir',
    name: 'repo-skill/',
    line: 'the same skill',
    note: 'copy 1 of 4',
    x: 1510,
    y: 300,
    w: 260,
    tilt: -2,
    at: 4.72,
    to: 'source control',
    duplicate: true,
  },
  {
    kind: 'md',
    name: 'overdue.md',
    line: 'customer data in the prompt',
    note: 'sent to a model nobody approved',
    x: 620,
    y: 450,
    w: 320,
    tilt: 1,
    at: 5.1,
    to: 'ERP',
  },
  {
    kind: 'ps1',
    name: 'payroll_check.ps1',
    line: 'run by hand every Friday',
    note: 'nobody else can run it',
    x: 200,
    y: 470,
    w: 290,
    tilt: -3,
    at: 5.48,
    to: 'HR and payroll',
  },
  {
    kind: 'ts',
    name: 'mail-bot.ts',
    line: 'one API key for everyone',
    note: 'in the repository',
    x: 1030,
    y: 470,
    w: 270,
    tilt: 2,
    at: 5.86,
    to: 'mail and calendar',
  },
  {
    kind: 'dir',
    name: 'repo-skill/',
    line: 'the same skill',
    note: 'copy 2 of 4',
    x: 1380,
    y: 440,
    w: 250,
    tilt: 3,
    at: 6.24,
    to: 'source control',
    duplicate: true,
  },
  {
    kind: 'java',
    name: 'crm_export.java',
    line: 'another team, same lookup',
    note: 'nobody knows the other exists',
    x: 890,
    y: 360,
    w: 290,
    tilt: -3.5,
    at: 6.62,
    to: 'CRM',
    duplicate: true,
  },
  {
    kind: 'sh',
    name: 'inbox_rules.sh',
    line: 'cron on someone’s VM',
    note: 'the VM is under a desk',
    x: 120,
    y: 640,
    w: 270,
    tilt: 2,
    at: 7,
    to: 'mail and calendar',
  },
  {
    kind: 'dir',
    name: 'repo-skill/',
    line: 'the same skill',
    note: 'copy 3 of 4',
    x: 1560,
    y: 570,
    w: 230,
    tilt: -1.5,
    at: 7.38,
    to: 'source control',
    duplicate: true,
  },
  {
    kind: 'py',
    name: 'kb_sync.py',
    line: 'Python 3.8, pinned',
    note: 'do not upgrade',
    x: 430,
    y: 650,
    w: 250,
    tilt: -2.5,
    at: 7.76,
    to: 'knowledge base',
  },
  {
    kind: 'zip',
    name: 'scripts_final_v3.zip',
    line: 'handed round on a USB stick',
    note: 'which version is live?',
    x: 750,
    y: 620,
    w: 310,
    tilt: 1.5,
    at: 8.14,
  },
  {
    kind: 'dir',
    name: 'chat-bot/',
    line: 'a personal token',
    note: 'leaves with its owner',
    x: 1100,
    y: 650,
    w: 250,
    tilt: -1,
    at: 8.52,
    to: 'chat',
  },
  {
    kind: 'dir',
    name: 'repo-skill/',
    line: 'the same skill',
    note: 'copy 4 of 4',
    x: 1360,
    y: 690,
    w: 230,
    tilt: 2,
    at: 8.9,
    to: 'source control',
    duplicate: true,
  },
]

/** The board card that becomes the film's subject. */
/** The cards that call the same system light up together: the same thing, built again. */
export const DUPLICATE_PULSE = { from: 9, duration: 2.2 }
/** The board clears as Routecraft is named. This is the film's turn, and the score changes key on it. */
export const BOARD_EXIT = { from: 12.2, duration: 1.2 }

export const LOCAL_PANEL: Rect = { x: 120, y: 430, w: 780, h: 330 }
export const TEAM_PANEL: Rect = { x: 1020, y: 430, w: 780, h: 330 }
export const TOP_BAND: Rect = { x: 120, y: 250, w: 1680, h: 110 }

export const LOCAL_PANEL_IN = { from: 12.9, duration: 1.2 }
export const TEAM_IN = { from: 13.4, duration: 1.2 }
/** Capabilities other teams already run: the platform is shared before this one arrives. */
export const TEAM_BLOCKS = ['query CRM', 'send mail', 'payroll']
export const TEAM_BLOCK_AT = [15.2, 15.6, 16]

/** The one capability the film follows, from the local harness to every caller. */
export const CAPABILITY = 'overdue invoices'
export const CAPABILITY_AT = 21
export const ROUTE_LINE = {
  at: 23,
  text: 'from  invoices  ›  filter  overdue  ›  to  caller',
}
export const TEST_LINE = {
  at: 24.9,
  text: '✓  tested locally, 3 of 3 cases pass',
}

const BLOCK_W = 168
const BLOCK_H = 72
const BLOCK_GAP = 18
export const blockRect = (panel: Rect, i: number): Rect => ({
  x: panel.x + 30 + i * (BLOCK_W + BLOCK_GAP),
  y: panel.y + panel.h - 30 - BLOCK_H,
  w: BLOCK_W,
  h: BLOCK_H,
})

export const PROMOTE = { from: 27.6, duration: 1 }
/** The capability crossing from the local harness to the team harness. */
export const CROSSING = { from: 28.2, duration: 1.6 }
export const CREDENTIALS = { from: 30, duration: 1 }
export const ACCESS_LINE = {
  at: 31.6,
  text: 'access   finance · sales · daily report',
}

export const TOP_BAND_IN = { from: 33.6, duration: 0.8 }
export const DOORS = ['editor', 'MCP', 'CLI', 'HTTP']
export const TRIGGERS = ['cron', 'webhook', 'mail', 'events', 'files']
export const DOOR_AT = (i: number) => 33.9 + i * 0.2
export const TRIGGER_AT = (i: number) => 34.4 + i * 0.15

/** Each caller reaches the same capability through its own way in. */
export const CALLS = [
  { at: 35, caller: 'finance', door: 'MCP' },
  { at: 37.2, caller: 'sales', door: 'editor' },
  { at: 40, caller: 'daily', door: 'cron' },
] as const

export const TELEMETRY = { from: 46, duration: 0.6 }
export const RECORD_LINES = [
  { at: 47.4, text: '09:00:00  overdue-invoices  daily · cron      ok' },
  { at: 48, text: '09:14:02  overdue-invoices  finance · agent   ok' },
  { at: 48.6, text: '09:15:40  overdue-invoices  sales · editor    ok' },
]

/** The next team's local harness appears behind the first: what one team proves, every team can use. */
export const SECOND_LOCAL = { from: 51, duration: 0.8 }

/** Labels fade out and the drawing settles into the platform picture. */
export const SETTLE = { from: 52.3, duration: 1.4 }
export const SCENE_OUT = { from: 54.6, duration: 1 }

/**
 * Moments that get a note in the score: each card landing, each block
 * arriving, each call. Derived here so the music cannot drift from the picture.
 */
export const SCORE_EVENTS: { at: number; weight: number }[] = [
  ...BOARD.map((c) => ({ at: c.at, weight: 0.7 })),
  ...TEAM_BLOCK_AT.map((at) => ({ at, weight: 0.8 })),
  { at: CAPABILITY_AT, weight: 1.2 },
  { at: CROSSING.from + CROSSING.duration, weight: 1 },
  ...CALLS.map((call) => ({ at: call.at + 0.6, weight: 1 })),
  ...RECORD_LINES.map((line) => ({ at: line.at, weight: 0.5 })),
]

/**
 * The voice-over. Each line starts at `at` and must be spoken by `end`;
 * `scripts/film/voice.ts` speeds a line up slightly when the voice runs long,
 * and refuses one that would need more than that.
 */
export const NARRATION: { at: number; end: number; text: string }[] = [
  {
    at: 0.4,
    end: 6.1,
    text: 'Your teams are building useful AI tools. But the work is fragmented.',
  },
  {
    at: 6.3,
    end: 12.1,
    text: 'Scattered scripts. Personal logins. The next team builds the same thing again.',
  },
  {
    at: 12.4,
    end: 20,
    text: 'Routecraft is an open source platform for AI capabilities your teams can run and reuse.',
  },
  {
    at: 20.3,
    end: 27.2,
    text: 'Start with one: find overdue invoices. Build it in TypeScript. Test it on your laptop.',
  },
  {
    at: 27.5,
    end: 34.1,
    text: 'Deploy it on your infrastructure. Service credentials. Access rules you control.',
  },
  {
    at: 34.4,
    end: 39.3,
    text: 'Finance calls it from an agent. Sales, from their editor.',
  },
  {
    at: 39.6,
    end: 45.6,
    text: 'Run it on a schedule. Same capability. No duplicated integration.',
  },
  {
    at: 45.9,
    end: 50.6,
    text: 'Enable telemetry. Record who called it, and what happened.',
  },
  { at: 50.9, end: 55, text: 'What one team proves, every team can use.' },
  { at: 56.4, end: 60, text: 'Routecraft. Built to be used.' },
]

/** What the voice says, in order: the film's transcript. */
export const TRANSCRIPT: string[] = NARRATION.map((line) => line.text)
