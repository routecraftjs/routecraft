import { type Node } from '@markdoc/markdoc'
import { slugifyWithCounter } from '@sindresorhus/slugify'

import { adapterGridTocSections } from '@/components/AdapterGrid'
import { type BadgeColor } from '@/components/Badge'
import { operationsTocSections } from '@/components/OperationsIndex'
import { pluginIndexTocSections } from '@/components/PluginIndex'

interface HeadingNode extends Node {
  type: 'heading'
  attributes: {
    level: 1 | 2 | 3 | 4 | 5 | 6
    id?: string
    [key: string]: unknown
  }
}

type H2Node = HeadingNode & {
  attributes: {
    level: 2
  }
}

type H3Node = HeadingNode & {
  attributes: {
    level: 3
  }
}

function isHeadingNode(node: Node): node is HeadingNode {
  return (
    node.type === 'heading' &&
    [1, 2, 3, 4, 5, 6].includes(node.attributes.level) &&
    (typeof node.attributes.id === 'string' ||
      typeof node.attributes.id === 'undefined')
  )
}

function isH2Node(node: Node): node is H2Node {
  return isHeadingNode(node) && node.attributes.level === 2
}

function isH3Node(node: Node): node is H3Node {
  return isHeadingNode(node) && node.attributes.level === 3
}

function extractHeadingContent(node: Node): {
  title: string
  badges: Array<{ text: string; color?: BadgeColor }>
} {
  let title = ''
  const badges: Array<{ text: string; color?: BadgeColor }> = []

  for (const child of node.children ?? []) {
    if (child.type === 'text') {
      title += String(child.attributes?.content ?? '')
      continue
    }

    if (child.type === 'tag' && child.tag === 'badge') {
      // Extract inner text for badge label, do not include in title
      const inner = extractHeadingContent(child)
      const color = child.attributes?.color as BadgeColor | undefined
      const text = inner.title.trim()
      if (text) badges.push({ text, color })
      continue
    }

    // Recurse into other inline nodes (e.g., emphasis, code)
    const inner = extractHeadingContent(child)
    if (inner.title) title += inner.title
    if (inner.badges.length) badges.push(...inner.badges)
  }

  return { title: title.trim(), badges }
}

export type Subsection = H3Node['attributes'] & {
  id: string
  title: string
  badges?: Array<{ text: string; color?: BadgeColor }>
  children?: undefined
}

export type Section = H2Node['attributes'] & {
  id: string
  title: string
  badges?: Array<{ text: string; color?: BadgeColor }>
  children: Array<Subsection>
}

/**
 * Index components render entire reference catalogues (operations,
 * adapters, plugins) as React tags rather than markdown headings, so
 * walking the Markdoc AST alone produces an empty "On this page"
 * sidebar for those pages. Each component exports its outline (with
 * ids matching the DOM it renders); this registry maps the Markdoc tag
 * name to that outline so `collectSections` can expand it in place.
 * The lazy thunks keep the data co-located with the component that
 * renders it; components import only the `Section` TYPE back, so there
 * is no runtime import cycle.
 */
const indexTagSections: Record<string, () => Array<Section>> = {
  'operations-index': operationsTocSections,
  'adapter-grid': adapterGridTocSections,
  'plugin-index': pluginIndexTocSections,
}

export function collectSections(
  nodes: Array<Node>,
  slugify = slugifyWithCounter(),
) {
  const sections: Array<Section> = []

  for (const node of nodes) {
    if (node.type === 'tag' && node.tag && node.tag in indexTagSections) {
      sections.push(...indexTagSections[node.tag]())
      continue
    }

    if (isH2Node(node) || isH3Node(node)) {
      const { title, badges } = extractHeadingContent(node)
      if (title) {
        const id = slugify(title)
        if (isH3Node(node)) {
          if (!sections[sections.length - 1]) {
            throw new Error(
              'Cannot add `h3` to table of contents without a preceding `h2`',
            )
          }
          sections[sections.length - 1].children.push({
            ...node.attributes,
            id,
            title,
            badges,
          })
        } else {
          sections.push({ ...node.attributes, id, title, badges, children: [] })
        }
      }
    }

    sections.push(...collectSections(node.children ?? [], slugify))
  }

  return sections
}
