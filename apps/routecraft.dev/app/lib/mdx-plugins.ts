/**
 * Heading id plugins that reproduce the Markdoc slugger byte for byte.
 *
 * Heading anchors are load-bearing on this site: the error reference links to
 * `#rc-1001`-style ids, the reference catalogue validates rows against heading
 * anchors, and deep links into the docs are pinned outside this repository.
 * Stock `rehype-slug` would change them, because it derives the slug from a
 * heading's full text content while Markdoc derived it from the heading's
 * direct string children only.
 *
 * That difference is not cosmetic. `### Core {% badge %}Breaking{% /badge %}`
 * published `#core`, not `#core-breaking`, and `## [v0.6.0](...)` published an
 * empty id because a link is not a string child. Both shapes exist in content
 * today, so the old semantics are reproduced rather than modernised.
 */

import { slugifyWithCounter } from '@sindresorhus/slugify'
import { visit } from 'unist-util-visit'
import type { Root as HastRoot, Element } from 'hast'
import type { Root as MdastRoot } from 'mdast'

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/**
 * Lifts a trailing `\{#custom-id}` marker out of a heading and onto its id.
 *
 * The brace is escaped in content because MDX reads `{...}` as an expression,
 * so by the time this runs the marker is ordinary text.
 */
export function remarkHeadingId() {
  return (tree: MdastRoot) => {
    visit(tree, 'heading', (node) => {
      const last = node.children.at(-1)
      if (!last || last.type !== 'text') return

      const match = /\s*\{#([\w-]+)\}\s*$/.exec(last.value)
      if (!match) return

      last.value = last.value.slice(0, match.index)
      if (last.value === '') node.children.pop()

      node.data ??= {}
      node.data.hProperties = { ...node.data.hProperties, id: match[1] }
    })
  }
}

/**
 * Fills in the remaining heading ids using the Markdoc slugger's semantics.
 *
 * One counter per document, consumed only by headings without an explicit id,
 * so the `-2` suffixes land on the same headings they land on today.
 */
export function rehypeMarkdocSlug() {
  return (tree: HastRoot) => {
    const slugify = slugifyWithCounter()

    visit(tree, 'element', (node: Element) => {
      if (!HEADINGS.has(node.tagName)) return
      if (typeof node.properties?.id === 'string') return

      const text = node.children
        .filter((child) => child.type === 'text')
        .map((child) => (child as { value: string }).value)
        .join(' ')

      node.properties = { ...node.properties, id: slugify(text) }
    })
  }
}
