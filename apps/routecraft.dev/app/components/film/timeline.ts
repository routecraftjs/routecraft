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
export const FILM_DURATION = 72

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
    to: 4.8,
    centred: true,
    parts: [
      {
        at: 0.6,
        text: 'Your company is ',
        accent: 'already',
        after: ' building AI tools.',
      },
    ],
  },
  {
    from: 5.5,
    to: 14.8,
    parts: [
      { at: 5.5, text: 'Scripts on SharePoint. ' },
      { at: 8.3, text: 'Prompts in markdown. ' },
      { at: 11.1, text: 'Tokens copied from a browser.' },
    ],
  },
  {
    from: 15.4,
    to: 20,
    parts: [
      { at: 15.4, text: 'Shared like it’s ', accent: '1985', after: '.' },
    ],
  },
  {
    from: 21,
    to: 24.6,
    parts: [
      {
        at: 21,
        text: 'A markdown file is an ',
        accent: 'instruction',
        after: '.',
      },
    ],
  },
  {
    from: 24.6,
    to: 27.6,
    parts: [
      {
        at: 24.6,
        text: 'An instruction needs a ',
        accent: 'harness',
        after: '.',
      },
    ],
  },
  {
    from: 27.6,
    to: 30.6,
    parts: [
      { at: 27.6, text: 'A harness needs ', accent: 'tools', after: '.' },
    ],
  },
  {
    from: 31,
    to: 37.8,
    parts: [
      {
        at: 31,
        text: 'In Routecraft, the tools are ',
        accent: 'capabilities',
        after: '. ',
      },
      { at: 33.4, text: 'The harness comes with them.' },
    ],
  },
  {
    from: 38.6,
    to: 49.6,
    parts: [
      { at: 38.6, text: 'Build it on your laptop. ' },
      { at: 42.4, text: '', accent: 'Promote', after: ' it when it works. ' },
      { at: 45.6, text: 'Every team installs it.' },
    ],
  },
  {
    from: 50.4,
    to: 59.8,
    parts: [
      { at: 50.4, text: 'Every way in. ' },
      { at: 55.6, text: 'Service credentials. ' },
      { at: 57.2, text: 'Every call ', accent: 'on record', after: '.' },
    ],
  },
  {
    from: 60.4,
    to: 66,
    parts: [
      {
        at: 60.4,
        text: 'Harnesses that work together are a ',
        accent: 'platform',
        after: '.',
      },
    ],
  },
]

/** The closing card: logo, name and tagline. */
export const END_CARD = { from: 67, to: FILM_DURATION + 1 }

export const SYSTEMS = [
  { label: 'CRM', w: 96 },
  { label: 'ERP', w: 96 },
  { label: 'HR and payroll', w: 200 },
  { label: 'ticketing', w: 150 },
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
    line: 'SharePoint › Ops › scripts',
    note: 'runs when someone remembers',
    x: 140,
    y: 280,
    w: 270,
    tilt: -2,
    at: 5.6,
    to: 'CRM',
  },
  {
    kind: 'md',
    name: 'copilot-instructions.md',
    line: 'twelve steps, no tools',
    note: 'works on one laptop',
    x: 470,
    y: 250,
    w: 320,
    tilt: 1.5,
    at: 6.7,
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
    at: 7.8,
    to: 'ticketing',
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
    at: 8.9,
    to: 'ERP',
  },
  {
    kind: 'dir',
    name: 'github-skill/',
    line: 'the same skill',
    note: 'copy 1 of 4',
    x: 1510,
    y: 300,
    w: 260,
    tilt: -2,
    at: 10,
    to: 'source control',
  },
  {
    kind: 'md',
    name: 'triage.md',
    line: 'customer data in the prompt',
    note: 'sent to a model nobody approved',
    x: 620,
    y: 450,
    w: 320,
    tilt: 1,
    at: 11.1,
    to: 'ticketing',
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
    at: 12.2,
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
    at: 13.3,
    to: 'mail and calendar',
  },
  {
    kind: 'dir',
    name: 'github-skill/',
    line: 'the same skill',
    note: 'copy 2 of 4',
    x: 1380,
    y: 440,
    w: 250,
    tilt: 3,
    at: 15.2,
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
    at: 15.75,
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
    at: 16.3,
    to: 'mail and calendar',
  },
  {
    kind: 'dir',
    name: 'github-skill/',
    line: 'the same skill',
    note: 'copy 3 of 4',
    x: 1560,
    y: 570,
    w: 230,
    tilt: -1.5,
    at: 16.85,
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
    at: 17.4,
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
    at: 17.95,
  },
  {
    kind: 'dir',
    name: 'slack-bot/',
    line: 'a personal token',
    note: 'leaves with its owner',
    x: 1100,
    y: 650,
    w: 250,
    tilt: -1,
    at: 18.5,
    to: 'chat',
  },
  {
    kind: 'dir',
    name: 'github-skill/',
    line: 'the same skill',
    note: 'copy 4 of 4',
    x: 1360,
    y: 690,
    w: 230,
    tilt: 2,
    at: 19.05,
    to: 'source control',
  },
]

/** The board card that becomes the film's subject. */
export const SUBJECT = BOARD.findIndex((c) => c.name === 'triage.md')

export const BOARD_EXIT = { from: 20.2, duration: 1.2 }

/** The subject card, read up close. */
export const ZOOM_CARD: Rect = { x: 700, y: 330, w: 520, h: 250 }
export const ZOOM_MOVE = { from: 20.4, duration: 1.8 }
export const TRIAGE_STEPS = [
  'Search the logs for the service.',
  'Open a ticket with what you found.',
  'Look up the customer in the CRM.',
]

export const HARNESS_BOX: Rect = { x: 560, y: 270, w: 800, h: 530 }
export const HARNESS_DRAW = { from: 24.8, duration: 1.4 }

export const TOOLS = ['read logs', 'open ticket', 'query CRM'] as const
export const TOOL_RECTS: Rect[] = TOOLS.map((_, i) => ({
  x: 610 + i * 240,
  y: 650,
  w: 220,
  h: 100,
}))
export const TOOL_AT = [27.8, 28.3, 28.8]

/** Tools turn into capabilities, the instruction becomes a skill. */
export const BECOME_CAPABILITIES = { from: 31.2, stagger: 0.35, duration: 0.8 }
export const BECOME_LOCAL = { from: 33.6, duration: 0.8 }

export const LOCAL_PANEL: Rect = { x: 120, y: 430, w: 780, h: 330 }
export const TEAM_PANEL: Rect = { x: 1020, y: 430, w: 780, h: 330 }
export const TOP_BAND: Rect = { x: 120, y: 250, w: 1680, h: 110 }

/** The harness shrinks into the local panel. */
export const TO_PLATFORM = { from: 38.8, duration: 2.4 }

const BLOCK_W = 168
const BLOCK_H = 72
const BLOCK_GAP = 18
export const blockRect = (panel: Rect, i: number): Rect => ({
  x: panel.x + 30 + i * (BLOCK_W + BLOCK_GAP),
  y: panel.y + panel.h - 30 - BLOCK_H,
  w: BLOCK_W,
  h: BLOCK_H,
})

export const TEAM_IN = { from: 41.4, duration: 1 }
export const PROMOTE = { from: 42.6, duration: 1 }
/** The promoted capability crossing from local to team. */
export const CROSSING = { from: 43.4, duration: 1.6, capability: 0 }
export const TEAM_BLOCKS = ['read logs', 'open ticket', 'query CRM', 'health']
export const TEAM_BLOCK_AT = [45, 45.5, 45.9, 46.3]
export const SECOND_LOCAL = { from: 46.4, duration: 0.8 }
export const REMOTE = { from: 47.2, duration: 1 }

export const TOP_BAND_IN = { from: 50.4, duration: 0.8 }
export const DOORS = ['editor', 'MCP', 'CLI', 'HTTP']
export const TRIGGERS = ['cron', 'webhook', 'mail', 'events', 'files']
export const DOOR_AT = (i: number) => 51.2 + i * 0.35
export const TRIGGER_AT = (i: number) => 52.9 + i * 0.3
export const ENTRY_ARROWS = { from: 54.6, duration: 0.8 }
export const ASKS_YOU = { from: 55.2, duration: 0.8 }
export const CREDENTIALS = { from: 55.8, duration: 1 }

export const RECORD_LINES = [
  { at: 57.3, text: '09:14:02  logs:read      ana via agent   ok' },
  { at: 57.9, text: '09:14:05  tickets:write  ana via agent   ok' },
  { at: 58.5, text: '09:15:40  cron           digest           ok' },
]

/** Labels fade out and the drawing settles into the platform picture. */
export const SETTLE = { from: 60.2, duration: 1.4 }
export const SCENE_OUT = { from: 66, duration: 1 }

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
    end: 5.5,
    text: 'Right now, every team in your company is building its own AI tools.',
  },
  {
    at: 5.8,
    end: 15.1,
    text: 'A script in a SharePoint folder. A prompt in a markdown file. A token copied out of a browser.',
  },
  { at: 15.5, end: 20.3, text: 'Shared like it’s 1985. On a memory stick.' },
  { at: 20.8, end: 24.5, text: 'But a markdown file is only an instruction.' },
  { at: 24.8, end: 27.5, text: 'An instruction needs a harness.' },
  { at: 27.8, end: 30.8, text: 'And a harness needs tools.' },
  {
    at: 31.1,
    end: 38.4,
    text: 'In Routecraft, those tools are capabilities. And the harness comes with them.',
  },
  {
    at: 38.8,
    end: 50.1,
    text: 'Build it on your laptop. When it works, promote it to the team harness. Every other team installs it, instead of building it again.',
  },
  {
    at: 50.5,
    end: 60.1,
    text: 'Reach it from any editor or agent, or let it run on a schedule. Service credentials. Every call on record.',
  },
  { at: 60.5, end: 66.4, text: 'Harnesses that work together are a platform.' },
  { at: 67.4, end: 71.8, text: 'Routecraft. Give AI access, not control.' },
]

/** What the voice says, in order: the film's transcript. */
export const TRANSCRIPT: string[] = NARRATION.map((line) => line.text)
