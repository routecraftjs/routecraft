/**
 * The docs search index.
 *
 * Replaces the webpack virtual module that built a FlexSearch index at compile
 * time. Vite resolves the content through a raw glob instead, so the index is
 * assembled when the module is first imported, which is when the user opens
 * search rather than on page load.
 *
 * Only the released channel is indexed. `/docs/next` is unreleased content and
 * is excluded here for the same reason it is excluded from the sitemap.
 */

import FlexSearch from 'flexsearch'

import { createHeadingSlugger, headingLabel } from '@/lib/heading-id'

/**
 * The index signature is required by the autocomplete library's `BaseItem`
 * constraint, which the previous untyped search module satisfied implicitly.
 */
export interface Result extends Record<string, unknown> {
  url: string
  title: string
  pageTitle?: string
}

interface Section {
  title: string
  hash: string | null
  content: string[]
}

const SOURCES = import.meta.glob<string>('../content/docs/**/index.mdx', {
  eager: true,
  query: '?raw',
  import: 'default',
})

const FENCE = /^\s*(```+|~~~+)/

function frontmatterTitle(source: string): string {
  return /^title:\s*(.*?)\s*$/m.exec(source.split('---')[1] ?? '')?.[1] ?? ''
}

function sectionsOf(source: string): Section[] {
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, '')
  const slug = createHeadingSlugger()
  const sections: Section[] = [
    { title: frontmatterTitle(source), hash: null, content: [] },
  ]

  let fence: string | null = null

  for (const line of body.split('\n')) {
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (fence === null) fence = marker
      else if (marker.startsWith(fence)) fence = null
      continue
    }
    if (fence !== null) continue

    const heading = /^(#{2,3})\s+(.*)$/.exec(line)
    if (heading) {
      sections.push({
        title: headingLabel(heading[2]),
        hash: slug(heading[2]),
        content: [],
      })
      continue
    }

    const text = line.trim()
    if (text !== '' && !text.startsWith('<')) {
      sections.at(-1)?.content.push(text)
    }
  }

  return sections
}

function urlOf(path: string): string {
  const slug = path
    .slice(path.indexOf('/content/docs') + '/content/docs'.length)
    .replace(/\/index\.mdx$/, '')
  return `/docs${slug}`
}

/** FlexSearch's document type rejects optional fields, hence the empty string. */
interface IndexedSection extends Record<string, string> {
  url: string
  title: string
  content: string
  pageTitle: string
}

const index = new FlexSearch.Document<IndexedSection>({
  tokenize: 'full',
  document: {
    id: 'url',
    index: ['content'],
    store: ['title', 'pageTitle'],
  },
  context: { resolution: 9, depth: 2, bidirectional: true },
})

for (const [path, source] of Object.entries(SOURCES)) {
  const url = urlOf(path)
  const sections = sectionsOf(source)

  for (const section of sections) {
    index.add({
      url: section.hash ? `${url}#${section.hash}` : url,
      title: section.title,
      content: [section.title, ...section.content].join('\n'),
      pageTitle: section.hash ? sections[0].title : '',
    })
  }
}

export function search(query: string, options: { limit?: number } = {}) {
  const results = index.search(query, { ...options, enrich: true })
  if (results.length === 0) return []

  const hits: Result[] = []

  for (const item of results[0].result) {
    if (!item.doc) continue
    hits.push({
      url: String(item.id),
      title: item.doc.title,
      pageTitle: item.doc.pageTitle || undefined,
    })
  }

  return hits
}
