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
import type { Heading, Paragraph, Root } from 'mdast'

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
 * Lifts a lone image out of its paragraph.
 *
 * Markdown images are inline, so a picture on its own line still parses into a
 * paragraph. The lightbox that renders them is a block element, and a block
 * inside a paragraph is invalid HTML: the browser closes the paragraph early
 * while React keeps the nesting, and hydration fails on that page. The old
 * build shipped the same broken markup.
 */
export function remarkUnwrapImages() {
  return (tree: Root) => {
    visit(tree, 'paragraph', (node, index, parent) => {
      if (!parent || index === undefined) return

      const meaningful = node.children.filter(
        (child) => child.type !== 'text' || child.value.trim() !== '',
      )
      if (meaningful.length !== 1 || meaningful[0].type !== 'image') return

      const image = meaningful[0]
      // An explicit `{#id}` on the paragraph was assigned before this runs, so
      // the promoted image inherits it rather than dropping the anchor.
      if (node.data?.hProperties) {
        image.data = {
          ...image.data,
          hProperties: { ...node.data.hProperties, ...image.data?.hProperties },
        }
      }

      parent.children[index] = image
    })
  }
}

/**
 * Reference catalogues that render their own outline.
 *
 * They are components rather than markdown headings, so a page built around one
 * would otherwise publish an empty "On this page" sidebar.
 */
const OUTLINE_COMPONENTS = new Set([
  'OperationsIndex',
  'AdapterGrid',
  'PluginIndex',
])

/**
 * Takes a trailing `\{#custom-id}` marker off a block's last text child and
 * returns the id it named. The brace is escaped in content because MDX would
 * otherwise read `{...}` as an expression, so by the time this runs the marker
 * is ordinary text.
 */
function takeExplicitId(node: {
  children: Array<{ type: string; value?: string }>
}): string | undefined {
  const last = node.children.at(-1)
  if (last?.type !== 'text' || last.value === undefined) return undefined

  const match = /\s*\{#([\w-]+)\}\s*$/.exec(last.value)
  if (!match) return undefined

  last.value = last.value.slice(0, match.index)
  if (last.value === '') node.children.pop()
  return match[1]
}

/**
 * Assigns heading ids and exports the page's table of contents as `toc`, plus
 * the outline-owning components it uses as `outlines`.
 *
 * An explicit `\{#custom-id}` marker wins, and works on a paragraph as well as
 * a heading: Markdoc annotated any block, and the mail reference points at
 * three paragraphs that way. Left unhandled the marker renders as literal text
 * and the anchors it names do not exist.
 */
export function remarkDocsHeadings() {
  return (tree: Root) => {
    const slugify = slugifyWithCounter()
    const toc: TocEntry[] = []
    const outlines: string[] = []

    visit(tree, 'mdxJsxFlowElement', (node: { name?: string | null }) => {
      if (node.name && OUTLINE_COMPONENTS.has(node.name))
        outlines.push(node.name)
    })

    visit(tree, 'paragraph', (node: Paragraph) => {
      const explicit = takeExplicitId(node)
      if (!explicit) return

      node.data ??= {}
      node.data.hProperties = { ...node.data.hProperties, id: explicit }
    })

    visit(tree, 'heading', (node: Heading) => {
      const explicit = takeExplicitId(node)

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

    const value = [
      `export const toc = ${JSON.stringify(toc)}`,
      `export const outlines = ${JSON.stringify(outlines)}`,
    ].join('\n')

    tree.children.unshift({
      type: 'mdxjsEsm',
      value,
      data: {
        estree: parse(value, { ecmaVersion: 'latest', sourceType: 'module' }),
      },
    } as unknown as Root['children'][number])
  }
}
