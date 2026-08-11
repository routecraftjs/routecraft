import { MdxComponents } from '@/components/mdx'
import type { DocsChannelName } from '@/lib/docs-channel'
import type { DocsPage } from '@/lib/docs-content'

/**
 * Renders one docs page for a channel.
 *
 * The channel is threaded down from the route rather than read from the
 * content, so the next-channel snapshot can stay a verbatim copy of the
 * released tree.
 */
export function DocsPageView({
  channel,
  page,
}: {
  channel: DocsChannelName
  page: DocsPage
}) {
  const Content = page.module.default

  return (
    <MdxComponents channel={channel}>
      <Content />
    </MdxComponents>
  )
}
