/**
 * Heading ids computed from MDX source text.
 *
 * The rendered pages get their ids from `remarkDocsHeadings`, which walks the
 * real syntax tree. Build-time consumers that only have the source text (the
 * search index, the reference catalogue) need the same answer, so the rule is
 * stated once here.
 *
 * The rule is Markdoc's, deliberately: a heading's id comes from its direct
 * text only. Inline code, links, emphasis and components contribute nothing,
 * which is why `### Core <Badge>Breaking</Badge>` is `#core` and a heading that
 * is nothing but a link has an empty id.
 */

import { slugifyWithCounter } from '@sindresorhus/slugify'

const EXPLICIT_ID = /\s*\\?\{#([\w-]+)\}\s*$/

/** Strips everything a heading's direct text does not include. */
export function headingText(heading: string): string {
  return heading
    .replace(EXPLICIT_ID, '')
    .replace(/`[^`]*`/g, '')
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
    .replace(/<[^>]+\/>/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[*_]{1,3}/g, '')
    .trim()
}

/** The visible label, which unlike the id does include inline code and links. */
export function headingLabel(heading: string): string {
  return heading
    .replace(EXPLICIT_ID, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+\/>/g, '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/[*_]{1,3}/g, '')
    .trim()
}

export function explicitHeadingId(heading: string): string | undefined {
  return EXPLICIT_ID.exec(heading)?.[1]
}

/** A slugger scoped to one document, matching the per-page counter semantics. */
export function createHeadingSlugger(): (heading: string) => string {
  const slugify = slugifyWithCounter()

  return (heading: string) =>
    explicitHeadingId(heading) ?? slugify(headingText(heading))
}
