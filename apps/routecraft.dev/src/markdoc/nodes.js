import { nodes as defaultNodes, Tag } from '@markdoc/markdoc'
import { slugifyWithCounter } from '@sindresorhus/slugify'
import yaml from 'js-yaml'
import Markdoc from '@markdoc/markdoc'

import { DocsLayout } from '@/components/DocsLayout'
import { Fence } from '@/components/Fence'
import { InlineCode } from '@/components/InlineCode'

let documentSlugifyMap = new Map()

function extractTitleAndBadges(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { title: input, badges: [] }
  }
  try {
    const ast = Markdoc.parse(input)
    function walk(node) {
      let title = ''
      let badges = []
      for (let child of node.children ?? []) {
        if (child.type === 'text') {
          title += String(child.attributes?.content ?? '')
          continue
        }
        const isTag = child.type === 'tag'
        const tagName = isTag ? (child.name ?? child.tag) : undefined
        if (isTag && tagName === 'badge') {
          const inner = walk(child)
          const color = child.attributes?.color
          const text = inner.title.trim()
          if (text) badges.push({ text, color })
          continue
        }
        const inner = walk(child)
        if (inner.title) title += inner.title
        if (inner.badges.length) badges.push(...inner.badges)
      }
      return { title: title.trim(), badges }
    }
    const { title, badges } = walk(ast)
    return { title: title || input, badges }
  } catch {
    return { title: input, badges: [] }
  }
}

function normalizeBadges(maybeArrayOrItem) {
  if (!maybeArrayOrItem) return []
  const arr = Array.isArray(maybeArrayOrItem)
    ? maybeArrayOrItem
    : [maybeArrayOrItem]
  return arr
    .map((b) => {
      if (typeof b === 'string') return { text: b }
      if (b && typeof b === 'object') {
        const text = typeof b.text === 'string' ? b.text : ''
        const color = typeof b.color === 'string' ? b.color : undefined
        if (text) return { text, color }
      }
      return null
    })
    .filter(Boolean)
}

const nodes = {
  document: {
    ...defaultNodes.document,
    render: DocsLayout,
    transform(node, config) {
      documentSlugifyMap.set(config, slugifyWithCounter())

      const fm = yaml.load(node.attributes.frontmatter)
      const { title, badges: parsedBadges } = extractTitleAndBadges(fm?.title)

      // Prefer explicit frontmatter badges over parsed ones
      const explicitBadges = [
        ...normalizeBadges(fm?.titleBadges),
        ...normalizeBadges(fm?.titleBadge),
      ]
      const titleBadges =
        explicitBadges.length > 0 ? explicitBadges : parsedBadges

      return new Tag(
        this.render,
        {
          frontmatter: { ...fm, title, titleBadges },
          nodes: node.children,
        },
        node.transformChildren(config),
      )
    },
  },
  code: {
    ...defaultNodes.code,
    render: InlineCode,
    transform(node) {
      const content = node.attributes.content ?? ''
      return new Tag(this.render, {}, [content])
    },
  },
  heading: {
    ...defaultNodes.heading,
    transform(node, config) {
      let slugify = documentSlugifyMap.get(config)
      let attributes = node.transformAttributes(config)
      let children = node.transformChildren(config)
      let text = children.filter((child) => typeof child === 'string').join(' ')
      let id = attributes.id ?? slugify(text)

      return new Tag(
        `h${node.attributes.level}`,
        { ...attributes, id },
        children,
      )
    },
  },
  th: {
    ...defaultNodes.th,
    attributes: {
      ...defaultNodes.th.attributes,
      scope: {
        type: String,
        default: 'col',
      },
    },
  },
  fence: {
    render: Fence,
    attributes: {
      language: {
        type: String,
      },
    },
  },
}

export default nodes
