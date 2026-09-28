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
export const FILM_DURATION = 74

/** A frame worth showing when the film is not playing: the settled platform. */
export const FILM_POSTER_TIME = 65

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
    to: 5.2,
    centred: true,
    parts: [
      {
        at: 0.6,
        text: 'Somewhere in your company, a script ',
        accent: 'already',
        after: ' calls the CRM.',
      },
    ],
  },
  {
    from: 5.5,
    to: 16.4,
    parts: [
      { at: 5.5, text: 'Down the hall, another team writes it again. ' },
      { at: 8.7, text: 'A prompt in markdown. ' },
      { at: 10.8, text: 'A token from a browser. ' },
      { at: 13.3, text: 'All on ', accent: 'personal logins', after: '.' },
    ],
  },
  {
    from: 16.5,
    to: 22.4,
    parts: [
      { at: 16.5, text: 'Nobody else can use them. ' },
      {
        at: 18.4,
        text: 'When they leave, the tool ',
        accent: 'leaves with them',
        after: '.',
      },
    ],
  },
  {
    from: 22.5,
    to: 27.6,
    parts: [
      { at: 22.5, text: 'Your people are not short of ideas. ' },
      {
        at: 24.9,
        text: 'They are short of a ',
        accent: 'place to run them',
        after: '.',
      },
    ],
  },
  {
    from: 27.7,
    to: 31.2,
    parts: [
      {
        at: 27.7,
        text: 'A markdown file is only an ',
        accent: 'instruction',
        after: '.',
      },
    ],
  },
  {
    from: 31.3,
    to: 34.3,
    parts: [
      {
        at: 31.3,
        text: 'An instruction needs a ',
        accent: 'harness',
        after: '.',
      },
    ],
  },
  {
    from: 34.4,
    to: 37.4,
    parts: [
      { at: 34.4, text: 'A harness needs ', accent: 'tools', after: '.' },
    ],
  },
  {
    from: 37.5,
    to: 43.2,
    parts: [
      {
        at: 37.5,
        text: 'In Routecraft, those tools are ',
        accent: 'capabilities',
        after: '. ',
      },
      { at: 40.1, text: 'The harness comes with them.' },
    ],
  },
  {
    from: 43.3,
    to: 51,
    parts: [
      { at: 43.3, text: 'Build it on your laptop. ' },
      { at: 45, text: '', accent: 'Promote', after: ' it when it works. ' },
      { at: 46.7, text: 'Every other team can use it.' },
    ],
  },
  {
    from: 51.3,
    to: 60.6,
    parts: [
      { at: 51.3, text: 'Every way in. ' },
      { at: 56.3, text: 'Service credentials. ' },
      { at: 58.2, text: 'Every call ', accent: 'on record', after: '.' },
    ],
  },
  {
    from: 61,
    to: 67.2,
    parts: [
      {
        at: 61,
        text: 'Harnesses that work together are a ',
        accent: 'platform',
        after: '. ',
      },
      { at: 63.7, text: 'The one your teams build on together.' },
    ],
  },
]

/** The closing card: logo, name and tagline. */
export const END_CARD = { from: 68.4, to: FILM_DURATION + 1 }

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
    at: 5.7,
    to: 'CRM',
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
    at: 6.5,
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
    at: 7.4,
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
    at: 8.2,
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
    at: 9,
    to: 'source control',
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
    at: 9.9,
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
    at: 10.7,
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
    at: 11.55,
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
    at: 13,
    to: 'source control',
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
    at: 13.4,
    to: 'CRM',
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
    at: 13.8,
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
    at: 14.25,
    to: 'source control',
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
    at: 14.7,
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
    at: 15.1,
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
    at: 15.5,
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
    at: 15.9,
    to: 'source control',
  },
]

/** The board card that becomes the film's subject. */
export const SUBJECT = BOARD.findIndex((c) => c.name === 'overdue.md')

/** The full board holds under the third and fourth lines, then clears into the zoom. */
export const BOARD_EXIT = { from: 26.4, duration: 1.2 }

/** The subject card, read up close. */
export const ZOOM_CARD: Rect = { x: 700, y: 330, w: 520, h: 250 }
export const ZOOM_MOVE = { from: 27.6, duration: 1.8 }
export const SUBJECT_STEPS = [
  'Look up the customer in the CRM.',
  'Check the invoice in the ERP.',
  'Send the reminder from the shared mailbox.',
]

export const HARNESS_BOX: Rect = { x: 560, y: 270, w: 800, h: 530 }
export const HARNESS_DRAW = { from: 31.4, duration: 1.4 }

export const TOOLS = ['query CRM', 'read invoice', 'send mail'] as const
export const TOOL_RECTS: Rect[] = TOOLS.map((_, i) => ({
  x: 610 + i * 240,
  y: 650,
  w: 220,
  h: 100,
}))
export const TOOL_AT = [34.5, 35, 35.5]

/**
 * Tools turn into capabilities, the instruction becomes a skill. This is the
 * film's turn: the problem is answered here, and the score changes key on it.
 */
export const BECOME_CAPABILITIES = { from: 37.7, stagger: 0.35, duration: 0.8 }
export const BECOME_LOCAL = { from: 40.2, duration: 0.8 }

export const LOCAL_PANEL: Rect = { x: 120, y: 430, w: 780, h: 330 }
export const TEAM_PANEL: Rect = { x: 1020, y: 430, w: 780, h: 330 }
export const TOP_BAND: Rect = { x: 120, y: 250, w: 1680, h: 110 }

/** The harness shrinks into the local panel. */
export const TO_PLATFORM = { from: 43.4, duration: 2.4 }

const BLOCK_W = 168
const BLOCK_H = 72
const BLOCK_GAP = 18
export const blockRect = (panel: Rect, i: number): Rect => ({
  x: panel.x + 30 + i * (BLOCK_W + BLOCK_GAP),
  y: panel.y + panel.h - 30 - BLOCK_H,
  w: BLOCK_W,
  h: BLOCK_H,
})

export const TEAM_IN = { from: 45, duration: 1 }
export const PROMOTE = { from: 45.9, duration: 1 }
/** The promoted capability crossing from local to team. */
export const CROSSING = { from: 46.5, duration: 1.6, capability: 0 }
export const TEAM_BLOCKS = ['query CRM', 'read invoice', 'send mail', 'payroll']
export const TEAM_BLOCK_AT = [48, 48.5, 48.9, 49.3]
export const SECOND_LOCAL = { from: 49.4, duration: 0.8 }
export const REMOTE = { from: 50.2, duration: 1 }

export const TOP_BAND_IN = { from: 51.3, duration: 0.8 }
export const DOORS = ['editor', 'MCP', 'CLI', 'HTTP']
export const TRIGGERS = ['cron', 'webhook', 'mail', 'events', 'files']
export const DOOR_AT = (i: number) => 52.1 + i * 0.35
export const TRIGGER_AT = (i: number) => 54 + i * 0.3
export const ENTRY_ARROWS = { from: 55.6, duration: 0.8 }
export const ASKS_YOU = { from: 56, duration: 0.8 }
export const CREDENTIALS = { from: 56.4, duration: 1 }

export const RECORD_LINES = [
  { at: 58.3, text: '09:14:02  crm:read       ana via agent   ok' },
  { at: 58.9, text: '09:14:05  mail:send      ana via agent   ok' },
  { at: 59.5, text: '09:15:40  cron           digest           ok' },
]

/** Labels fade out and the drawing settles into the platform picture. */
export const SETTLE = { from: 60.8, duration: 1.4 }
export const SCENE_OUT = { from: 67.4, duration: 1 }

/**
 * Moments that get a note in the score: each card landing, each block
 * arriving. Derived here so the music cannot drift from the picture.
 */
export const SCORE_EVENTS: { at: number; weight: number }[] = [
  ...BOARD.map((c) => ({ at: c.at, weight: 0.7 })),
  ...TOOL_AT.map((at) => ({ at, weight: 1 })),
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
    end: 5.3,
    text: 'Somewhere in your company, a script already calls the CRM.',
  },
  {
    at: 5.6,
    end: 16.3,
    text: 'Down the hall, another team is writing it again. A prompt in a markdown file. A token copied out of a browser. Every one of them on somebody’s personal login.',
  },
  {
    at: 16.6,
    end: 22.3,
    text: 'Nobody else can use them. And the day that person leaves, the tool leaves with them.',
  },
  {
    at: 22.6,
    end: 27.5,
    text: 'Your people are not short of ideas. They are short of a place to run them.',
  },
  { at: 27.7, end: 31.2, text: 'A markdown file is only an instruction.' },
  { at: 31.4, end: 34.3, text: 'An instruction needs a harness.' },
  { at: 34.5, end: 37.3, text: 'And a harness needs tools.' },
  {
    at: 37.6,
    end: 43.1,
    text: 'In Routecraft, those tools are capabilities. And the harness comes with them.',
  },
  {
    at: 43.4,
    end: 50.7,
    text: 'Build it on your laptop. When it works, promote it. Every other team can use it, instead of building it again.',
  },
  {
    at: 51.4,
    end: 60.5,
    text: 'Reach it from any editor or agent, or let it run on a schedule. Service credentials, not personal logins. Every call on record.',
  },
  {
    at: 61,
    end: 66.8,
    text: 'Harnesses that work together are a platform. The one your teams build on together.',
  },
  { at: 69, end: 72.4, text: 'Routecraft. Built to be used.' },
]

/** What the voice says, in order: the film's transcript. */
export const TRANSCRIPT: string[] = NARRATION.map((line) => line.text)
