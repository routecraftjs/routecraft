import { fourGates } from '@/components/figures/four-gates'
import { handsNotKeys } from '@/components/figures/hands-not-keys'
import { FIGURE_TEXT } from '@/components/figures/manifest.mjs'
import { maturityLadder } from '@/components/figures/maturity-ladder'
import { serverVsDoorway } from '@/components/figures/server-vs-doorway'
import { singlePlayerVsMultiplayer } from '@/components/figures/single-player-vs-multiplayer'
import { teamAgentHarness } from '@/components/figures/team-agent-harness'
import type {
  FigureDefinition,
  FigureDrawing,
} from '@/components/figures/types'

/** The drawings, in the order the gallery and the export walk them. */
const DRAWINGS: FigureDrawing[] = [
  singlePlayerVsMultiplayer,
  maturityLadder,
  handsNotKeys,
  fourGates,
  serverVsDoorway,
  teamAgentHarness,
]

/**
 * Every blog figure, keyed by the id used in post frontmatter (`diagram:`) and
 * in the `{% diagram %}` tag. A post's first figure is normally the one it
 * declares as `diagram:`, which is what the cover, the card, and the social
 * image draw their artwork from.
 *
 * A drawing is joined here to its words from `manifest.mjs`. A drawing with no
 * entry there would render an unnamed image and an empty markdown alt, so it
 * fails the build instead.
 */
const FIGURES: FigureDefinition[] = DRAWINGS.map((drawing) => {
  const text = FIGURE_TEXT[drawing.id]
  if (!text) {
    throw new Error(
      `[figures] no alt or caption in manifest.mjs for figure: ${drawing.id}`,
    )
  }
  return { ...drawing, ...text }
})

const BY_ID = new Map(FIGURES.map((figure) => [figure.id, figure]))

if (process.env.NODE_ENV !== 'production' && BY_ID.size !== FIGURES.length) {
  // A duplicate id silently shadows the earlier figure (Map keeps the last
  // writer), so surface it the same way an unknown id is surfaced below.
  const seen = new Set<string>()
  for (const figure of FIGURES) {
    if (seen.has(figure.id))
      console.warn(`[figures] duplicate figure id: ${figure.id}`)
    seen.add(figure.id)
  }
}

/**
 * Every figure, in declaration order. Backs the `/figures` gallery and the
 * static params of `/figures/[id]`, which is also what the PNG export walks.
 */
export function allFigures(): readonly FigureDefinition[] {
  return FIGURES
}

export function getFigure(
  id: string | undefined,
): FigureDefinition | undefined {
  if (!id) return undefined
  const figure = BY_ID.get(id)
  if (!figure && process.env.NODE_ENV !== 'production') {
    // A named-but-unknown id is an author error (a typo or a renamed figure),
    // not the legitimate no-id glyph fallback. Surface it instead of silently
    // dropping the diagram from the post and its cover.
    console.warn(`[figures] unknown figure id: ${id}`)
  }
  return figure
}

export type { FigureDefinition } from '@/components/figures/types'
