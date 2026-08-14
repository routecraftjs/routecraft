import { Suspense } from 'react'

import { DocsLayout } from '@/components/DocsLayout'
import { MdxComponents } from '@/components/mdx'
import { adapterGridTocSections } from '@/components/AdapterGrid'
import { operationsTocSections } from '@/components/OperationsIndex'
import { pluginIndexTocSections } from '@/components/PluginIndex'
import type { DocsChannelName } from '@/lib/docs-channel'
import { docsComponent } from '@/lib/docs-content'
import type { DocsFrontmatter } from '@/lib/docs-content'
import type { TocEntry } from '@/lib/mdx-plugins'
import type { Section } from '@/lib/sections'

/**
 * Outlines contributed by components rather than by markdown headings, keyed by
 * the component that renders them. Each returns the rows for the channel it is
 * read on, so the sidebar lists exactly what the page shows.
 */
const OUTLINES: Record<string, (channel: DocsChannelName) => Section[]> = {
  OperationsIndex: operationsTocSections,
  AdapterGrid: adapterGridTocSections,
  PluginIndex: pluginIndexTocSections,
}

/**
 * Renders one docs page for a channel.
 *
 * The channel is threaded down from the route rather than read from the
 * content, which is what lets the next-channel snapshot stay a verbatim copy of
 * the released tree.
 */
export interface DocsPageData {
  frontmatter: DocsFrontmatter
  toc: TocEntry[]
  outlines: string[]
}

export function DocsPageView({
  channel,
  slug,
  page,
}: {
  channel: DocsChannelName
  slug: string
  page: DocsPageData
}) {
  const Content = docsComponent(channel, slug)

  if (!Content) return null

  const sections: Section[] = [
    ...page.toc.map((entry) => ({
      level: 2 as const,
      id: entry.id,
      title: entry.title,
      children: entry.children.map((child) => ({
        level: 3 as const,
        id: child.id,
        title: child.title,
      })),
    })),
    ...page.outlines.flatMap((name) => OUTLINES[name]?.(channel) ?? []),
  ]

  return (
    <DocsLayout frontmatter={page.frontmatter} sections={sections}>
      <MdxComponents channel={channel}>
        {/* The fallback holds the column open. Page modules load lazily, and an
            empty article lets the flex row redistribute, which moves the
            navigation and the outline sideways until the chunk arrives. */}
        <Suspense fallback={<div className="min-h-screen" />}>
          {/* Not created here: docsComponent is a lookup into a map of lazy
              components built once at module scope, so the type is stable
              across renders and the page keeps its state. */}
          {/* eslint-disable-next-line react-hooks/static-components */}
          <Content />
        </Suspense>
      </MdxComponents>
    </DocsLayout>
  )
}
