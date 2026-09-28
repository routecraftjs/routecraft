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
export const FILM_DURATION = 71

/** A frame worth showing when the film is not playing: the settled platform. */
export const FILM_POSTER_TIME = 63

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
    to: 6.2,
    centred: true,
    parts: [
      {
        at: 0.6,
        text: 'Right now, every team in your company is building its ',
        accent: 'own',
        after: ' AI tools.',
      },
    ],
  },
  {
    from: 6.4,
    to: 17.3,
    parts: [
      { at: 6.4, text: 'A script on a shared drive. ' },
      { at: 8.5, text: 'A prompt in markdown. ' },
      { at: 10.9, text: 'A token from a browser. ' },
      { at: 13.3, text: 'All on ', accent: 'personal logins', after: '.' },
    ],
  },
  {
    from: 17,
    to: 24.9,
    parts: [
      { at: 17, text: 'Nobody else can use them. ' },
      {
        at: 18.8,
        text: 'The next team builds it ',
        accent: 'again',
        after: '. ',
      },
      {
        at: 21,
        text: 'When someone leaves, the tool ',
        accent: 'leaves with them',
        after: '.',
      },
    ],
  },
  {
    from: 24.9,
    to: 30.8,
    parts: [
      { at: 24.9, text: 'Your engineers are not short of ideas. ' },
      {
        at: 27.5,
        text: 'They are short of a ',
        accent: 'place to run them',
        after: '.',
      },
    ],
  },
  {
    from: 31,
    to: 37.4,
    parts: [
      { at: 31, text: '', accent: 'Routecraft', after: ' is that place. ' },
      {
        at: 33.2,
        text: 'An open source platform your teams build on together.',
      },
    ],
  },
  {
    from: 37.5,
    to: 47,
    parts: [
      {
        at: 37.5,
        text: 'Build a capability on a ',
        accent: 'local harness',
        after: '. ',
      },
      { at: 40.3, text: '', accent: 'Promote', after: ' it when it works. ' },
      { at: 42.3, text: 'Every other team can use it.' },
    ],
  },
  {
    from: 46.9,
    to: 59.4,
    parts: [
      { at: 46.9, text: 'Every way in. ' },
      { at: 52.6, text: 'Service credentials. ' },
      { at: 54.8, text: 'Every call ', accent: 'on record', after: '. ' },
      {
        at: 56.5,
        text: 'One ',
        accent: 'standard',
        after: ', for every team.',
      },
    ],
  },
  {
    from: 59.5,
    to: 64.4,
    parts: [
      {
        at: 59.5,
        text: 'What one team ',
        accent: 'proves',
        after: ', every team can use.',
      },
    ],
  },
]

/** The closing card: logo, name and tagline. */
export const END_CARD = { from: 65.6, to: FILM_DURATION + 1 }

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
  /** Goes when its owner does. */
  leaves?: boolean
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
    at: 6.6,
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
    at: 7.4,
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
    at: 8.3,
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
    at: 9.1,
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
    at: 9.9,
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
    at: 10.8,
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
    at: 11.6,
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
    at: 12.45,
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
    at: 13.9,
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
    at: 14.3,
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
    at: 14.7,
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
    at: 15.15,
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
    at: 15.6,
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
    at: 16,
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
    at: 16.4,
    to: 'chat',
    leaves: true,
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
    at: 16.8,
    to: 'source control',
    duplicate: true,
  },
]

/** The board card that becomes the film's subject. */
export const SUBJECT = BOARD.findIndex((c) => c.name === 'overdue.md')

/** The full board holds under the third and fourth lines, then clears. */
export const BOARD_EXIT = { from: 30.2, duration: 1.2 }
/** The cards that call the same system light up together: the same thing, built again. */
export const DUPLICATE_PULSE = { from: 18.9, duration: 1.8 }
/** The card whose owner leaves goes with them. */
export const LEAVES = { from: 21.8, duration: 1 }

export const LOCAL_PANEL: Rect = { x: 120, y: 430, w: 780, h: 330 }
export const TEAM_PANEL: Rect = { x: 1020, y: 430, w: 780, h: 330 }
export const TOP_BAND: Rect = { x: 120, y: 250, w: 1680, h: 110 }

/**
 * The subject card lifts out of the board into its slot in the local harness.
 * This is the film's turn: the problem is answered here, and the score changes
 * key on it.
 */
export const TO_PLATFORM = { from: 31, duration: 2 }
export const LOCAL_PANEL_IN = { from: 31.3, duration: 1.2 }
/** The instruction is labelled a skill once it sits in the harness. */
export const BECOME_LOCAL = { from: 33.2, duration: 0.8 }

export const CAPABILITIES = ['query CRM', 'read invoice', 'send mail'] as const
export const CAPABILITY_AT = [37.8, 38.2, 38.6]

const BLOCK_W = 168
const BLOCK_H = 72
const BLOCK_GAP = 18
export const blockRect = (panel: Rect, i: number): Rect => ({
  x: panel.x + 30 + i * (BLOCK_W + BLOCK_GAP),
  y: panel.y + panel.h - 30 - BLOCK_H,
  w: BLOCK_W,
  h: BLOCK_H,
})

export const TEAM_IN = { from: 40.2, duration: 1 }
export const PROMOTE = { from: 41, duration: 1 }
/** The promoted capability crossing from local to team. */
export const CROSSING = { from: 41.8, duration: 1.6, capability: 0 }
export const TEAM_BLOCKS = ['query CRM', 'read invoice', 'send mail', 'payroll']
export const TEAM_BLOCK_AT = [43.4, 43.9, 44.3, 44.7]
export const REMOTE = { from: 45.4, duration: 1 }

export const TOP_BAND_IN = { from: 46.9, duration: 0.8 }
export const DOORS = ['editor', 'MCP', 'CLI', 'HTTP']
export const TRIGGERS = ['cron', 'webhook', 'mail', 'events', 'files']
export const DOOR_AT = (i: number) => 47.7 + i * 0.35
export const TRIGGER_AT = (i: number) => 49.6 + i * 0.3
export const ENTRY_ARROWS = { from: 51.2, duration: 0.8 }
export const ASKS_YOU = { from: 51.7, duration: 0.8 }
export const CREDENTIALS = { from: 52.7, duration: 1 }

export const RECORD_LINES = [
  { at: 54.9, text: '09:14:02  crm:read       ana via agent   ok' },
  { at: 55.5, text: '09:14:05  mail:send      ana via agent   ok' },
  { at: 56.1, text: '09:15:40  cron           digest           ok' },
]

/** The next team's local harness appears behind the first: one standard, every team. */
export const SECOND_LOCAL = { from: 56.7, duration: 0.8 }

/** Labels fade out and the drawing settles into the platform picture. */
export const SETTLE = { from: 59.3, duration: 1.4 }
export const SCENE_OUT = { from: 64.6, duration: 1 }

/**
 * Moments that get a note in the score: each card landing, each block
 * arriving. Derived here so the music cannot drift from the picture.
 */
export const SCORE_EVENTS: { at: number; weight: number }[] = [
  ...BOARD.map((c) => ({ at: c.at, weight: 0.7 })),
  ...CAPABILITY_AT.map((at) => ({ at, weight: 1 })),
  ...TEAM_BLOCK_AT.map((at) => ({ at, weight: 1 })),
  ...DOORS.map((_, i) => ({ at: DOOR_AT(i), weight: 0.8 })),
  ...TRIGGERS.map((_, i) => ({ at: TRIGGER_AT(i), weight: 0.6 })),
]

/**
 * The voice-over. Each line starts at `at` and must be spoken by `end`;
 * `scripts/film/voice.ts` speeds a line up slightly when the voice runs long,
 * and refuses one that would need more than that.
 */
export const NARRATION: { at: number; end: number; text: string }[] = [
  {
    at: 0.4,
    end: 6.3,
    text: 'Right now, every team in your company is building its own AI tools.',
  },
  {
    at: 6.5,
    end: 16.9,
    text: 'A script on a shared drive. A prompt in a markdown file. A token copied out of a browser. Every one of them on somebody’s personal login.',
  },
  {
    at: 17.1,
    end: 24.6,
    text: 'Nobody else can use them. The next team builds it again. And when someone leaves, the tool leaves with them.',
  },
  {
    at: 24.9,
    end: 30.7,
    text: 'Your engineers are not short of ideas. They are short of a place to run them.',
  },
  {
    at: 31,
    end: 37.3,
    text: 'Routecraft is that place. An open source platform your teams build on together.',
  },
  {
    at: 37.6,
    end: 46.7,
    text: 'Build a capability on a local harness. When it works, promote it. Every other team can use it, instead of building it again.',
  },
  {
    at: 47,
    end: 59.2,
    text: 'Reach it from any editor or agent, or let it run on a schedule. Service credentials, not personal logins. Every call on record. One standard, for every team.',
  },
  { at: 59.5, end: 63.5, text: 'What one team proves, every team can use.' },
  { at: 66.2, end: 69.6, text: 'Routecraft. Built to be used.' },
]

/** What the voice says, in order: the film's transcript. */
export const TRANSCRIPT: string[] = NARRATION.map((line) => line.text)
