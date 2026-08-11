import { createFileRoute } from '@tanstack/react-router'

import { DocsLayout } from '@/components/DocsLayout'
import { MdxComponents } from '@/components/mdx'
import { tocSections } from '@/lib/mdx-content'
import Changelog, { toc } from '../content/changelog/index.mdx'

export const Route = createFileRoute('/changelog')({
  component: () => (
    <DocsLayout
      frontmatter={{ title: 'Changelog' }}
      sections={tocSections(toc)}
    >
      <MdxComponents channel="latest">
        <Changelog />
      </MdxComponents>
    </DocsLayout>
  ),
})
