import { type BadgeColor } from '@/components/Badge'

/**
 * The shape of the "On this page" outline.
 *
 * Pages derive it from the `toc` their MDX module exports, which is built while
 * heading ids are assigned so the outline and the anchors cannot disagree.
 * Reference catalogues that render as components rather than headings
 * contribute their own entries in the same shape.
 */

export type Subsection = {
  level: 3
  id: string
  title: string
  badges?: Array<{ text: string; color?: BadgeColor }>
  children?: undefined
}

export type Section = {
  level: 2
  id: string
  title: string
  badges?: Array<{ text: string; color?: BadgeColor }>
  children: Array<Subsection>
}
