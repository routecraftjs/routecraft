import { type Node } from '@markdoc/markdoc'
import { slugifyWithCounter } from '@sindresorhus/slugify'

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

function getNodeText(node: Node) {
  let text = ''
  for (let child of node.children ?? []) {
    if (child.type === 'text') {
      text += child.attributes.content
    }
    text += getNodeText(child)
  }
  return text
}

function extractHeadingContent(node: Node): {
  title: string
  badges: Array<{ text: string; color?: string }>
} {
  let title = ''
  let badges: Array<{ text: string; color?: string }> = []

  for (let child of node.children ?? []) {
    if (child.type === 'text') {
      title += String((child as any).attributes?.content ?? '')
      continue
    }

    const isTag = child.type === 'tag'
    const tagName = isTag
      ? ((child as any).name ?? (child as any).tag)
      : undefined

    if (isTag && tagName === 'badge') {
      // Extract inner text for badge label, do not include in title
      const inner = extractHeadingContent(child)
      const color = (child as any).attributes?.color as string | undefined
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
  badges?: Array<{ text: string; color?: string }>
  children?: undefined
}

export type Section = H2Node['attributes'] & {
  id: string
  title: string
  badges?: Array<{ text: string; color?: string }>
  children: Array<Subsection>
}

export function collectSections(
  nodes: Array<Node>,
  slugify = slugifyWithCounter(),
) {
  let sections: Array<Section> = []

  for (let node of nodes) {
    if (isH2Node(node) || isH3Node(node)) {
      const { title, badges } = extractHeadingContent(node)
      if (title) {
        let id = slugify(title)
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
