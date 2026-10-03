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
    alt: 'Left: an agent holding one key that opens a door to a database, email, deploy and payments. Right: the same agent reaching two named tools, each stacked with an input, policy, identity and intent gate.',
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
  'function-to-mcp-tool': {
    alt: 'A capability of six lines, from craft() to .from(mcp()) and a transform, runs through craft run into an MCP server that Routecraft frames, validates, types, logs and shuts down for you. Claude Desktop, Cursor and the MCP Inspector call it over stdio.',
    caption: 'One TypeScript function in, one MCP tool out.',
  },
  'jev-screen-cascade': {
    alt: 'An agent result, made of the request, the account and the tool record, enters a Jev screen that answers one noul question with a probability. At or above passAt the result passes with no reasoning call; below it, or with no answer, it goes to an LLM judge for a verdict and a reason.',
    caption:
      'One question, two paths: the screen passes, or the judge explains.',
  },
  'team-agent-harness': {
    alt: 'A harness boundary holding four primitives (delegation, shared memory, capability gaps, channels) around a central model doing judgement only, sitting on three platform rules.',
    caption:
      'The four primitives of a team agent harness, and the model in the middle.',
  },
  'every-team-builds-its-own': {
    alt: "Ten tilted team cards (an invoice chaser on one VM, a recruitment agent on a laptop, expense approvals on a copied session cookie, support replies with their own model key, an MCP tools repo, payroll checks run by hand, agent skills, sales follow-ups on a rep's own login, and two ghosts not yet on any list), each wired by dashed lines straight into the same column of business systems: CRM, ERP, HR and payroll, support desk, knowledge base, mail and calendar, chat and source control. A list of ten patterns seen across them, from a token pasted into a .env to nothing another team can install.",
    caption:
      'Every team builds its own: a stack per team, a credential per person.',
  },
  platform: {
    alt: "The platform at its highest level. Across the top, every way in: people in their editor, agents over MCP, the CLI, HTTP and triggers. In the middle, a local harness per person on their own access, and an always-on team harness on service credentials, joined by promote when proven, remote, and capabilities, skills and agents shared as packages. The team harness asks a person when it needs a decision. Along the bottom, the organisation's systems as they are: CRM, ERP, HR and payroll, support desk, knowledge base, mail and calendar, chat and source control.",
    caption: 'One runtime, every way in, the same capabilities everywhere.',
  },
  'platform-architecture': {
    alt: 'The platform with every part named. Across the top, every way in: when someone asks, your editor over ACP, any MCP client, the CLI and HTTP; when nobody asks, cron and timers, webhooks, mail arriving, runtime events, files read at start and a parked task resuming; and you, approving by mail or chat. In the middle, a local harness per person on personal credentials (team capabilities over a remote, your own capabilities, an agent in your editor, the terminal UI) and the always-on team harness on service credentials (health and readiness, the ops API, telemetry on record when switched on, work that survives restarts, conversations that resume), joined by promote when proven, remote, and capabilities, skills and agents as npm packages. Below them, inside every harness: the gate, whose order is fixed and whose checks you configure (authenticate, authorise by scope, validate input, throttle, circuit breaker, retry, timeout, concurrency, cache), agents and skills, capabilities and their operations, adapters, and the runtime stores. Along the bottom, your systems as they are and any model provider you approve, reached on personal credentials from the laptop and service credentials from the team harness.',
    caption: 'One runtime, every way in, the same capabilities everywhere.',
  },
  'platform-stack': {
    alt: 'Six stacked bands, each a layer of the platform with a row of unlabelled blocks: every way in (editors, MCP clients, the CLI, HTTP and the triggers that wake it), agents, skills, capabilities, adapters, and your systems drawn as data stores. A bracket on the left spans the top five, which run on your laptop as a local harness or always on as the team harness; a cobalt strip on the right spans all six, where who asked, which door, which capability and which system are on record.',
    caption: 'One runtime, six layers, open at any depth.',
  },
}
