import { DocsLayout } from '@/components/DocsLayout'
import { MdxComponents } from '@/components/mdx'
import { adapterGridTocSections } from '@/components/AdapterGrid'
import { operationsTocSections } from '@/components/OperationsIndex'
import { pluginIndexTocSections } from '@/components/PluginIndex'
import type { DocsChannelName } from '@/lib/docs-channel'
import type { DocsPage } from '@/lib/docs-content'
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
export function DocsPageView({
  channel,
  page,
}: {
  channel: DocsChannelName
  page: DocsPage
}) {
  const Content = page.module.default

  const sections: Section[] = [
    ...(page.module.toc ?? []).map((entry) => ({
      level: 2 as const,
      id: entry.id,
      title: entry.title,
      children: entry.children.map((child) => ({
        level: 3 as const,
        id: child.id,
        title: child.title,
      })),
    })),
    ...(page.module.outlines ?? []).flatMap(
      (name) => OUTLINES[name]?.(channel) ?? [],
    ),
  ]

  return (
    <DocsLayout frontmatter={page.module.frontmatter ?? {}} sections={sections}>
      <MdxComponents channel={channel}>
        <Content />
      </MdxComponents>
    </DocsLayout>
  )
}
