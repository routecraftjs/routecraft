/**
 * Heading ids and table-of-contents data for MDX pages.
 *
 * Heading anchors are load-bearing on this site: the error reference links to
 * `#rc-1001`-style ids, the reference catalogue validates rows against heading
 * anchors, and deep links into the docs are pinned outside this repository.
 * Stock `rehype-slug` would change them, because it derives a slug from a
 * heading's full text content while Markdoc derived it from the heading's
 * direct string children only.
 *
 * That difference is not cosmetic. `### Core {% badge %}Breaking{% /badge %}`
 * published `#core`, not `#core-breaking`, and `## [v0.6.0](...)` published an
 * empty id because a link is not a string child. Both shapes exist in content
 * today, so the old semantics are reproduced rather than modernised.
 *
 * Ids are assigned in remark rather than rehype so the same pass can export the
 * page's table of contents, which the Markdoc build derived by walking its AST.
 */

import { parse } from 'acorn'
import { slugifyWithCounter } from '@sindresorhus/slugify'
import { visit } from 'unist-util-visit'
import type { Heading, Root } from 'mdast'

export interface TocEntry {
  id: string
  title: string
  children: TocEntry[]
}

/** Reproduces Markdoc's `children.filter(isString).join(' ')` over mdast. */
function directText(node: Heading): string {
  return node.children
    .filter((child) => child.type === 'text')
    .map((child) => (child as { value: string }).value)
    .join(' ')
}

/** The full text of a heading, used for the visible table-of-contents label. */
function visibleText(node: Heading): string {
  let text = ''
  visit(node, (child) => {
    if (child.type === 'text' || child.type === 'inlineCode') {
      text += (child as { value: string }).value
    }
  })
  return text.trim()
}

/**
 * Assigns heading ids and exports the page's table of contents as `toc`.
 *
 * An explicit `\{#custom-id}` marker wins. The brace is escaped in content
 * because MDX would otherwise read `{...}` as an expression, so by the time
 * this runs the marker is ordinary text.
 */
export function remarkDocsHeadings() {
  return (tree: Root) => {
    const slugify = slugifyWithCounter()
    const toc: TocEntry[] = []

    visit(tree, 'heading', (node: Heading) => {
      const last = node.children.at(-1)
      let explicit: string | undefined

      if (last?.type === 'text') {
        const match = /\s*\{#([\w-]+)\}\s*$/.exec(last.value)
        if (match) {
          explicit = match[1]
          last.value = last.value.slice(0, match.index)
          if (last.value === '') node.children.pop()
        }
      }

      // The counter is consumed only by headings without an explicit id, which
      // is what keeps the `-2` suffixes on the same headings they sit on today.
      const id = explicit ?? slugify(directText(node))

      node.data ??= {}
      node.data.hProperties = { ...node.data.hProperties, id }

      if (node.depth === 2) {
        toc.push({ id, title: visibleText(node), children: [] })
      } else if (node.depth === 3 && toc.length > 0) {
        toc[toc.length - 1].children.push({
          id,
          title: visibleText(node),
          children: [],
        })
      }
    })

    const value = `export const toc = ${JSON.stringify(toc)}`

    tree.children.unshift({
      type: 'mdxjsEsm',
      value,
      data: {
        estree: parse(value, { ecmaVersion: 'latest', sourceType: 'module' }),
      },
    } as unknown as Root['children'][number])
  }
}
