import { fourGates } from '@/components/figures/four-gates'
import { handsNotKeys } from '@/components/figures/hands-not-keys'
import { maturityLadder } from '@/components/figures/maturity-ladder'
import { serverVsDoorway } from '@/components/figures/server-vs-doorway'
import { singlePlayerVsMultiplayer } from '@/components/figures/single-player-vs-multiplayer'
import { teamAgentHarness } from '@/components/figures/team-agent-harness'
import type { FigureDefinition } from '@/components/figures/types'

/**
 * Every blog figure, keyed by the id used in post frontmatter (`diagram:`) and
 * in the `{% diagram %}` tag. A post's first figure is normally the one it
 * declares as `diagram:`, which is what the cover, the card, and the social
 * image draw their artwork from.
 */
const FIGURES: FigureDefinition[] = [
  singlePlayerVsMultiplayer,
  maturityLadder,
  handsNotKeys,
  fourGates,
  serverVsDoorway,
  teamAgentHarness,
]

const BY_ID = new Map(FIGURES.map((figure) => [figure.id, figure]))

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
