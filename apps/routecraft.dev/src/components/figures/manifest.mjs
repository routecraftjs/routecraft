/**
 * The plain-data half of a figure: its words, and where its exported PNGs live.
 *
 * This is plain JavaScript rather than TypeScript because it has to be read
 * from three places with different loaders: the React components (through
 * `figure-image.ts` and `index.ts`), the prebuild scripts that write
 * `public/raw/**`, and `clean-markdoc.mjs`, which also runs inside the webpack
 * config where TypeScript type stripping is not guaranteed. Keeping it plain
 * means one definition rather than one per loader.
 *
 * The drawings themselves stay in their own `.tsx` files; only the text they
 * carry lives here, so a figure's prose can be read without loading JSX.
 */

/** Where exported PNGs live, under `public/` and under the site root alike. */
export const FIGURE_IMAGE_DIR = 'images/figures'

/** Suffix appended to a figure id for the dark export. */
export const FIGURE_DARK_SUFFIX = '-dark'

/** Site-relative path to a figure's exported PNG. Light is the default. */
export function figureImagePath(id, theme = 'light') {
  const suffix = theme === 'dark' ? FIGURE_DARK_SUFFIX : ''
  return `/${FIGURE_IMAGE_DIR}/${id}${suffix}.png`
}

/**
 * Every figure's accessible name and default caption, keyed by figure id.
 *
 * `alt` is a real description, not a label: it is the accessible name in the
 * browser, and in the raw markdown it is all a reader who cannot fetch the
 * image has to go on.
 *
 * @type {Record<string, { alt: string, caption: string }>}
 */
export const FIGURE_TEXT = {
  'single-player-vs-multiplayer': {
    alt: 'Left: six identical agents, each on its own laptop with its own key and memory. Right: laptop, chat, phone and agent all entering through one SSO front door into three shared capabilities backed by platform-owned service accounts.',
    caption: 'Single-player agents, and the multiplayer alternative.',
  },
  'maturity-ladder': {
    alt: 'A five-stage ladder from prompt library at the bottom to organisational agents at the top. Stage two, a skills and agents repository, is marked "you are here"; stage four, deployed capabilities, is highlighted as the jump that matters.',
    caption: 'The maturity ladder, and the stage most teams are standing on.',
  },
  'hands-not-keys': {
    alt: 'Left: an agent holding one key that opens a door to a database, email, deploy and payments. Right: the same agent reaching two named tools, each stacked with an input, rules, identity and intent gate.',
    caption:
      'Keys open everything behind them. Hands only press what you built.',
  },
  'four-gates': {
    alt: 'A tool call falling through four stacked gates in order: input, policy, identity and declared intent. The policy gate diverts a call whose recipient is outside the company domain. What survives all four reaches your logic.',
    caption: 'The four gates every agent-facing tool runs on every call.',
  },
  'server-vs-doorway': {
    alt: 'Left: an agent calling an MCP server that holds three tools. Right: MCP, cron and HTTP all entering one Routecraft capability, which in turn calls other MCP servers and hosts the agent.',
    caption: 'Is the MCP server the product, or one doorway into the product?',
  },
  'team-agent-harness': {
    alt: 'A harness boundary holding four primitives (delegation, shared memory, capability gaps, channels) around a central model doing judgement only, sitting on three platform rules.',
    caption:
      'The four primitives of a team agent harness, and the model in the middle.',
  },
}
