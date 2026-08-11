import { createFileRoute } from '@tanstack/react-router'

import { DocsLayout } from '@/components/DocsLayout'
import { MdxComponents } from '@/components/mdx'
import { tocSections } from '@/lib/mdx-content'
import { absoluteUrl, canonicalPath, siteName } from '@/lib/site'
import Changelog, { toc } from '../content/changelog/index.mdx'

const description =
  'All notable changes to Routecraft, across released versions.'

export const Route = createFileRoute('/changelog')({
  head: () => ({
    meta: [
      { title: `Changelog - ${siteName}` },
      { name: 'description', content: description },
      { property: 'og:title', content: `Changelog - ${siteName}` },
      { property: 'og:description', content: description },
      { property: 'og:url', content: absoluteUrl(canonicalPath('/changelog')) },
    ],
    links: [
      { rel: 'canonical', href: absoluteUrl(canonicalPath('/changelog')) },
    ],
  }),
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
